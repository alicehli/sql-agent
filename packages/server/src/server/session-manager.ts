import { Session } from "./session";
import type { AttachmentPayload } from "@claude-agent-kit/messages";
import type {
  IClaudeAgentSDKClient,
  ISessionClient,
  SessionSDKOptions,
} from "../types";


export class SessionManager {

  /** List of known sessions, including inactive ones. */
  private sessionsList: Session[] = [];

  get sessions(): Session[] {
    return this.sessionsList;
  }

  /** Sessions sorted by last modification time, useful for quick-select menus. */
  get sessionsByLastModified(): Session[] {
    return [...this.sessionsList].sort(
      (left, right) => right.lastModifiedTime - left.lastModifiedTime,
    );
  }

  /** Look up a session by its Claude session id */
  getSession(sessionId: string, shouldLoadMessages = false): Session | undefined {
    const existing = this.sessionsList.find(
      (session) => session.sessionId === sessionId,
    );

    if (existing && shouldLoadMessages) {
      void existing.resumeFrom(sessionId);
    }

    return existing;
  }

  createSession(sdkClient: IClaudeAgentSDKClient): Session {
    const session = new Session(sdkClient);
    this.sessionsList.push(session);
    return session;
  }

  getOrCreateSession(client: ISessionClient): Session {
    let session = client.sessionId ? this.getSession(client.sessionId) : undefined;

    if (!session) {
      session = this.sessionsList.find((existing) => existing.hasClient(client));
    }

    if (!session) {
      session = this.createSession(client.sdkClient);
      // Update the client's sessionId to match the newly created session
      client.sessionId = session.sessionId || undefined;
    }
    return session;
  }


  subscribe(client: ISessionClient) {
    const session = this.getOrCreateSession(client);
    session.subscribe(client);
  }

  unsubscribe(client: ISessionClient): void {
    // Find the session by id, falling back to membership so a client with an
    // uninitialized sessionId is still detached (and the session still considered
    // for eviction).
    let session = client.sessionId ? this.getSession(client.sessionId) : undefined;
    if (!session) {
      session = this.sessionsList.find((existing) => existing.hasClient(client));
    }
    if (!session) {
      return;
    }
    session.unsubscribe(client);
    this.evictIfIdle(session);
  }

  /**
   * Drop an in-memory session once it has no subscribers and isn't actively
   * working. Without this, sessionsList grows for the lifetime of the process.
   * An evicted session is transparently recreated and reloaded from disk
   * (resumeFrom) the next time a client subscribes to it.
   */
  private evictIfIdle(session: Session): void {
    if (session.clientCount > 0 || session.isBusy || session.isLoading) {
      return;
    }
    const index = this.sessionsList.indexOf(session);
    if (index !== -1) {
      this.sessionsList.splice(index, 1);
    }
  }

  sendMessage(
    client: ISessionClient, 
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): void {
    const session = this.getOrCreateSession(client);
    session.subscribe(client);
    session.send(prompt, attachments);
  }

  setSDKOptions(
    client: ISessionClient,
    options: Partial<SessionSDKOptions>
  ): void {
    const session = this.getOrCreateSession(client);
    session.setSDKOptions(options);
  }

  interrupt(client: ISessionClient): void {
    const session = client.sessionId ? this.getSession(client.sessionId) : undefined;
    if (session) {
      session.interrupt();
    }
  }
}
