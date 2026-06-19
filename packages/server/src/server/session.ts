import { randomUUID } from "node:crypto";

import {
  buildUserMessageContent,
  type AttachmentPayload,
  type UsageSummary,
} from "@claude-agent-kit/messages";
import type {
  BranchResult,
  ClaudeConfig,
  SessionConfig,
  IClaudeAgentSDKClient,
  ISessionClient,
  OutcomingMessage,
  SessionStateUpdate,
  SessionStateSnapshot,
  SessionSDKOptions,
} from "../types";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  Options as SDKOptions,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

// Only safe tools that don't access local filesystem
// Sandbox and SQL tools are added via configureSessionMcpServers in server.ts
const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  // "Task",        // Disabled - spawns subagents which don't have sandbox access
  "ExitPlanMode",
  // "Glob",        // Local filesystem - disabled
  // "Grep",        // Local filesystem - disabled
  // "LS",          // Local filesystem - disabled
  // "Read",        // Local filesystem - disabled
  // "Edit",        // Local filesystem - disabled
  // "MultiEdit",   // Local filesystem - disabled
  // "Write",       // Local filesystem - disabled
  // "NotebookEdit",// Local filesystem - disabled
  "WebFetch",
  "TodoWrite",
  "WebSearch",
  "Skill",         // Enable skills from .claude/skills/
];

const REPORT_MODE_INSTRUCTIONS = `

## Report Mode (ENABLED) - MANDATORY REPORT GENERATION

**CRITICAL: Report Mode is active. You MUST generate a professional HTML report as the final deliverable for EVERY request.**

No matter what the user asks, your response MUST end with a polished HTML report saved to \`/sandbox/files/report.html\`. Even simple questions deserve a well-formatted report summarizing the findings.

### Mandatory Workflow

1. **Query the data** - Use query_connector (prefer tql_path) to get the information
2. **Create visualizations** - Generate charts for ANY numerical or categorical data (see chart requirements below)
3. **Build the report** - Use the **report-style-guide** skill to create a professional HTML report
4. **Save the report** - Write to \`/sandbox/files/report.html\`

### Report Requirements (ALL MANDATORY)

- Executive summary with 2-3 key insights
- Metrics dashboard showing important numbers
- **At least one chart/visualization** (bar, line, pie, etc.)
- Data tables for detailed breakdowns
- Conclusions and actionable recommendations

### Chart Requirements in Reports

Every report MUST include visualizations. If the data can be charted, chart it:
- Comparisons → Bar charts
- Trends over time → Line charts
- Distributions → Histograms or pie charts
- Relationships → Scatter plots

**Never deliver a report without at least one embedded chart.**

Always inform the user when the report is ready: "Your report has been saved to /sandbox/files/report.html"
`;

// Ontology context (ANA.md + .tql index) injected at runtime from the sandbox's
// read-only ./library mount. Org-level and stable, so it's set once per process.
let ontologyContext = "";

export function setOntologyContext(text: string): void {
  ontologyContext = text || "";
}

const DEFAULT_SYSTEM_PROMPT = `
# Agent Data

You are Agent Data, a data analysis assistant that helps users explore, analyze, and visualize data. You work inside a sandbox connected to TextQL's data connectors and a governed semantic layer (the "ontology").

When greeting users or introducing yourself, always say "I'm Agent Data" - never use any other name.

**IMPORTANT: Always generate visualizations.** For almost every data question, create a chart or graph to illustrate the findings. Don't just return numbers - show them visually.

## Your Workflow

1. **Discover data sources** - Use mcp__sandbox__list_connectors to see the TextQL connectors you can query (id, name, type).
2. **Ground yourself in the ontology FIRST** - The semantic layer is mounted read-only at \`./library\` in the sandbox. \`.tql\` files are governed, reusable queries; \`.md\` files (especially any \`ANA.md\`) are business context and definitions. **Before writing any SQL, explore \`./library\` with Python** (e.g. \`os.walk('library')\`, then read the relevant \`.tql\`/\`.md\` files). This is what makes answers correct and consistent across the org - skipping it leads to guessed joins and wrong numbers.
3. **Query via a connector** - Use mcp__sandbox__query_connector. **Prefer \`tql_path\`** (a path to a saved \`.tql\` under \`./library\`) for governed, semantic queries that reuse defined metrics and joins. Use raw \`query\` (SQL) only for genuinely ad-hoc needs the ontology doesn't cover. The \`.tql\` backend must match the connector. Results load as a pandas DataFrame in the sandbox.
4. **ALWAYS visualize with Python** - Operate on the loaded DataFrames; create charts for any numerical or categorical data.
5. **Save outputs** - Save charts and files to \`/sandbox/files/\`.

## Ontology-First (the most important habit)

The \`./library\` semantic layer is the source of truth. Treat it like a codebase you explore before acting:
- Walk it and read \`ANA.md\` / relevant \`.md\` for definitions ("what does 'active customer' mean here?").
- Search it for existing \`.tql\` that already answers the question, and run it via \`tql_path\` instead of re-deriving SQL.
- Only fall back to raw SQL when nothing in the ontology fits - and say so.

## Visualization-First Approach

**Generate a chart for almost every request.** Even if the user doesn't ask for one, **proactively create one** to make the data easier to understand.

✅ Counts/totals/aggregations → Bar chart
✅ Trends over time → Line chart
✅ Proportions/breakdowns → Pie or stacked bar
✅ Comparisons across categories → Grouped bar chart
✅ Distributions → Histogram
✅ Relationships → Scatter plot

❌ Skip charts for simple yes/no questions, single specific values, or schema/metadata questions.

## Available Tools

### TextQL Connector Tools (governed data access)
- **mcp__sandbox__list_connectors**: List available connectors (id, name, type), scoped to your TextQL permissions.
- **mcp__sandbox__query_connector**: Run a connector query and load the result into a sandbox DataFrame. Pass a connector_id and EXACTLY ONE of \`tql_path\` (preferred, governed) or \`query\` (raw SQL, ad-hoc).

### Sandbox Tools (Python execution + files)
- **mcp__sandbox__run_python**: Execute Python. This is your universal tool - use it to explore \`./library\` (os.walk, open/read), run shell via subprocess, wrangle DataFrames, and plot.
- **mcp__sandbox__run_command**: Run a shell command (e.g. \`grep -ri "revenue" library\`, pip install).
- **mcp__sandbox__write_file** / **read_file** / **list_files**: File I/O in the sandbox.

### Playbook Tools
- **mcp__playbooks__create_playbook**: Save a workflow as a reusable playbook (when the user says "save this as a playbook").
- **mcp__playbooks__update_playbook**: Rename or modify an existing playbook.

## Available Skills (IMPORTANT - USE THESE!)

Skills provide templates and styling guides. **Always invoke the relevant skill** before creating visualizations or reports.

### chart-style-guide
**When to use**: Before creating ANY chart or visualization (almost every request).
**How to invoke**: Use the Skill tool with skill="chart-style-guide"

### report-style-guide
**When to use**: Before creating ANY HTML report.
**How to invoke**: Use the Skill tool with skill="report-style-guide"

## Best Practices

1. **Ontology first** - Explore \`./library\` and prefer \`tql_path\` before writing raw SQL.
2. **Visualize by default** - Create a chart for almost every data question.
3. **Use skills for styling** - chart-style-guide before charts, report-style-guide before reports.
4. **Show your work** - Display key query results and intermediate findings.
5. **Summarize findings** - End with clear takeaways and recommendations.
6. **Handle errors gracefully** - If a query fails, explain why and try alternatives.
7. **Avoid emojis** - Keep responses professional and clean.

## Example Workflow

User: "Which account executives have the most pipeline?"

1. **mcp__sandbox__list_connectors** → find the relevant connector (e.g. a GTM/CRM connector).
2. **mcp__sandbox__run_python** → \`os.walk('library')\` and read the relevant \`.tql\`/\`.md\` (e.g. a pipeline or team-members query) to use defined metrics.
3. **mcp__sandbox__query_connector** with \`tql_path\` pointing at the governed query → loads a DataFrame.
4. **Invoke chart-style-guide skill**, then create a bar chart from the DataFrame with run_python.
5. Save chart to \`/sandbox/files/pipeline_by_ae.png\` and summarize.
`;

// Configurable MCP servers - can be set by the application
let customMcpServers: Record<string, McpServerConfig> = {};
let customAllowedTools: string[] = [];

export function configureSessionMcpServers(servers: Record<string, McpServerConfig>, additionalTools: string[] = []) {
  customMcpServers = servers;
  customAllowedTools = additionalTools;
}

const DEFAULT_SESSION_OPTIONS: SessionSDKOptions = {
  maxTurns: 100,
  allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  tools: [...DEFAULT_ALLOWED_TOOLS],  // Restrict available tools (allowedTools only sets auto-approve)
  mcpServers: {},
  model: "sonnet",
  hooks: {},
  thinkingLevel: "default_on",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  settingSources: ['project'],  // Enable .claude/skills/ loading
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: DEFAULT_SYSTEM_PROMPT,
  },
};

function normalizeWorkspacePath(value?: string | null): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

function createDefaultOptions(workspacePath?: string | null): SessionSDKOptions {
  const cwd = normalizeWorkspacePath(workspacePath);

  // Merge default tools with custom tools
  const allTools = [
    ...(DEFAULT_SESSION_OPTIONS.allowedTools ?? []),
    ...customAllowedTools,
  ];

  return {
    ...DEFAULT_SESSION_OPTIONS,
    allowedTools: allTools,
    tools: allTools,  // Restrict available tools (allowedTools only sets auto-approve)
    mcpServers: {
      ...(DEFAULT_SESSION_OPTIONS.mcpServers ?? {}),
      ...customMcpServers,
    },
    hooks: {
      ...(DEFAULT_SESSION_OPTIONS.hooks ?? {}),
    },
    ...(cwd ? { cwd } : {}),
  };
}


export class Session {
  sessionId: string | null = null; // Claude session ID
  options: SessionSDKOptions = createDefaultOptions();
  usageSummary: UsageSummary | undefined;
  claudeConfig: ClaudeConfig | undefined;
  modelSelection: string | undefined;
  config: SessionConfig | undefined;
  lastModifiedTime = Date.now();
  summary: string | undefined;
  error: Error | string | undefined;

  private sdkClient: IClaudeAgentSDKClient;
  private queryPromise: Promise<void> | null = null;
  private loadingPromise: Promise<void> | null = null;
  private abortController: AbortController | undefined = undefined;
  private busyState: boolean = false;
  private loadingState: boolean = false;
  private messageList: SDKMessage[] = [];
  private isLoaded = false;
  private clients: Set<ISessionClient> = new Set();

  constructor(sdkClient: IClaudeAgentSDKClient) {
    this.sdkClient = sdkClient;
  }

  get isBusy(): boolean {
    return this.busyState;
  }

  private setBusyState(state: boolean): void {
    if (this.busyState === state) {
      return;
    }
    this.busyState = state;
    this.emitSessionStateChange({ isBusy: state });
  }

  get isLoading(): boolean {
    return this.loadingState;
  }

  /** Number of clients currently subscribed to this session. */
  get clientCount(): number {
    return this.clients.size;
  }

  private setLoadingState(state: boolean): void {
    if (this.loadingState === state) {
      return;
    }
    this.loadingState = state;
    this.emitSessionStateChange({ isLoading: state });
  }

  setSDKOptions(
    options: Partial<SessionSDKOptions>,
  ): void {
    const hasExplicitCwd = Object.prototype.hasOwnProperty.call(options, "cwd");
    const normalizedCwd = hasExplicitCwd ? normalizeWorkspacePath(options.cwd ?? undefined) : undefined;

    const normalized: Partial<SessionSDKOptions> = {
      ...options,
      ...(hasExplicitCwd ? { cwd: normalizedCwd } : {}),
    };

    const baseOptions = createDefaultOptions(hasExplicitCwd ? normalizedCwd : this.options.cwd);
    const nextOptions: SessionSDKOptions = {
      ...baseOptions,
      ...this.options,
      ...normalized,
    };

    if (hasExplicitCwd && !normalizedCwd) {
      delete (nextOptions as Record<string, unknown>).cwd;
    }

    this.options = nextOptions;
    // Strip mcpServers and hooks for serialization
    const { mcpServers: _mcp, hooks: _hooks, ...serializableOptions } = this.buildEffectiveOptions();
    this.emitSessionStateChange({ options: serializableOptions as SessionSDKOptions });
  }

  private buildEffectiveOptions(): SessionSDKOptions {
    const baseOptions = createDefaultOptions(this.options.cwd);
    const options = {
      ...baseOptions,
      ...this.options,
    };

    // Build system prompt with optional report mode instructions
    const reportMode = this.options.reportMode === true;
    const basePrompt = reportMode
      ? DEFAULT_SYSTEM_PROMPT + REPORT_MODE_INSTRUCTIONS
      : DEFAULT_SYSTEM_PROMPT;
    // Inject the live ontology context (ANA.md + .tql index) when available.
    const systemPromptAppend = ontologyContext
      ? basePrompt + "\n\n" + ontologyContext
      : basePrompt;

    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend,
    };

    console.log('[Session] Effective options - settingSources:', options.settingSources, 'cwd:', options.cwd, 'reportMode:', reportMode);
    return options;
  }

  get messages(): SDKMessage[] {
    return this.messageList;
  }

  findWorkspacePathFromMessages(messages: SDKMessage[]): string | undefined {
    const cwdMessage = messages.find(msg => (msg as SDKSystemMessage).cwd) as SDKSystemMessage | undefined;
    return cwdMessage?.cwd || undefined;
  }

  private setMessages(messages: SDKMessage[]): void {
    this.messageList = messages;

    if (!this.options.cwd) {
      const detectedWorkspace = this.findWorkspacePathFromMessages(messages);
      if (detectedWorkspace) {
        this.setSDKOptions({ cwd: detectedWorkspace });
      }
    }

    console.log(
      `[Session] setMessages for ${this.sessionId ?? "pending"} count=${messages.length} (wasLoaded=${this.isLoaded})`,
    );
    this.notifyClients("messagesUpdated", {
      type: "messages_updated",
      sessionId: this.sessionId,
      messages,
    });
  }

  private syncClientSessionIds(): void {
    const sessionId = this.sessionId ?? undefined;
    this.clients.forEach((client) => {
      client.sessionId = sessionId;
    });
  }

  private updateSessionId(sessionId: string | null | undefined): void {
    const normalized = sessionId ?? null;
    if (this.sessionId === normalized) {
      return;
    }
    this.sessionId = normalized;
    this.syncClientSessionIds();
  }

  interrupt(): void {
    this.abortController?.abort();
    this.setBusyState(false);
  }


  // Subscribe a WebSocket client to this session
  subscribe(client: ISessionClient) {
    if (this.clients.has(client)) {
      return;
    }
    this.clients.add(client);
    client.sessionId = this.sessionId ?? undefined;
    const sessionState = this.getSessionStateSnapshot();
    console.log(
      `[Session] Client subscribed to ${this.sessionId ?? "uninitialized"} (messages=${this.messageList.length}, loaded=${this.isLoaded})`,
    );
    client.receiveSessionMessage(
      "sessionStateChanged",
      this.createSessionStateMessage(sessionState),
    );

    // When a client attaches to an already loaded session, immediately send the
    // current transcript so switching sessions always repopulates the UI.
    if (this.isLoaded) {
      client.receiveSessionMessage("messagesUpdated", {
        type: "messages_updated",
        sessionId: this.sessionId,
        messages: [...this.messageList],
      });
      console.log(`[Session] Sent cached transcript to client for ${this.sessionId}: ${this.messageList.length} messages`);
    }
  }

  unsubscribe(client: ISessionClient) {
    this.clients.delete(client);
  }

  hasClient(client: ISessionClient): boolean {
    return this.clients.has(client);
  }

  notifyClients(event: string, message: OutcomingMessage) {
    this.clients.forEach((client: ISessionClient) => {
      if (!client) {
        return;
      }
      client.receiveSessionMessage(event, message);
    });
  }

  addNewMessage(message: SDKMessage): void {
    this.messageList.push(message);
    this.notifyClients("messageAdded", {
      type: "message_added",
      sessionId: this.sessionId,
      message,
    });
  }

  loadFromServer(sessionId?: string): Promise<void> | undefined {
    const targetSessionId = sessionId ?? this.sessionId ?? undefined;
    if (!targetSessionId) {
      return undefined;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.updateSessionId(targetSessionId);
    this.setLoadingState(true);
    this.error = undefined;

    this.loadingPromise = (async () => {
      try {
        const { messages } = await this.sdkClient.loadMessages(targetSessionId);
        console.log(`[Session] loadFromServer(${targetSessionId}) returned ${messages.length} messages`);
        if (messages.length === 0) {
          this.setMessages([]);
          this.summary = undefined;
          this.lastModifiedTime = Date.now();
          this.setBusyState(false);
          return;
        }

        this.summary = undefined;
        this.setMessages(messages);
        this.setBusyState(false);
        this.isLoaded = true;
      } catch (error) {
        console.error(`Failed to load session '${targetSessionId}':`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.setLoadingState(false);
        this.loadingPromise = null;
        console.log(`[Session] Finished loading ${targetSessionId}`);
      }
    })();

    return this.loadingPromise;
  }

  async resumeFrom(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    console.log(
      `[Session] resumeFrom ${sessionId} (current=${this.sessionId ?? "none"}, loaded=${this.isLoaded})`,
    );

    if (this.sessionId === sessionId && this.isLoaded) {
      console.log(`[Session] resumeFrom short-circuited for ${sessionId} (already loaded)`);
      return;
    }

    await this.loadFromServer(sessionId);
    console.log(`[Session] resumeFrom finished loading ${sessionId}`);
  }

  // Process a single user message
  async send(
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): Promise<void> {
    if (this.queryPromise) {
      // Queue is busy, wait for it
      await this.queryPromise;
    }

    // Build the synthetic user message that will kick off the stream.
    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: buildUserMessageContent(prompt, attachments),
      },
    };
    this.abortController = new AbortController();

    async function* generateMessages() {
      yield userMessage;
    }

    this.addNewMessage(userMessage);

    // Seed the session summary with the user's first prompt if needed.
    if (!this.summary) {
      this.summary = prompt;
    }

    this.lastModifiedTime = Date.now();
    this.setBusyState(true);

    this.queryPromise = (async () => {
      try {
        const { thinkingLevel: _thinkingLevel, ...effectiveOptions } = this.buildEffectiveOptions();
        const options: SDKOptions = {
          ...effectiveOptions,
          abortController: this.abortController,
        };

        // Use resume for multi-turn, continue for first message
        if (this.sessionId) {
          options.resume = this.sessionId;
        }


        for await (const message of this.sdkClient.queryStream(
          generateMessages(),
          options
        )) {
          console.log(message);
          this.processIncomingMessage(message);
        }
      } catch (error) {
        console.error(`Error in session ${this.sessionId}:`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.queryPromise = null;
        this.setBusyState(false);
      }
    })();

    await this.queryPromise;
    this.lastModifiedTime = Date.now();
  }


  // Branch from a specific message in another session (creates new worldline)
  // This is an "edit" operation - the branch replaces the specified message, not continues after it
  async branch(
    sourceSessionId: string,
    branchAtMessageUuid: string,
    prompt: string,
    attachments: AttachmentPayload[] | undefined
  ): Promise<BranchResult> {
    if (this.queryPromise) {
      await this.queryPromise;
    }

    console.log(`[Session] Branching from ${sourceSessionId} at message ${branchAtMessageUuid}`);

    // Load the source session to find the parent of the branch point message
    // We need to resume from the PARENT, not the branch point itself, so the new message REPLACES the old one
    let resumeAtUuid = branchAtMessageUuid;
    try {
      const { messages: sourceMessages } = await this.sdkClient.loadMessages(sourceSessionId);
      const branchPointMessage = sourceMessages.find(
        (msg) => (msg as { uuid?: string }).uuid === branchAtMessageUuid
      );
      if (branchPointMessage) {
        const parentUuid = (branchPointMessage as { parentUuid?: string | null }).parentUuid;
        if (parentUuid) {
          console.log(`[Session] Found parent of branch point: ${parentUuid} (branch point: ${branchAtMessageUuid})`);
          resumeAtUuid = parentUuid;
        } else {
          console.log(`[Session] Branch point has no parent, this is the first message`);
          // If no parent, we're branching from the first message - don't include any history
          resumeAtUuid = "";
        }
      } else {
        console.warn(`[Session] Could not find branch point message ${branchAtMessageUuid} in source session`);
      }
    } catch (error) {
      console.error(`[Session] Failed to load source session for parent lookup:`, error);
      // Fall back to original behavior if we can't find the parent
    }

    // Reset session state for the new branch
    this.sessionId = null;
    this.messageList = [];
    this.isLoaded = false;

    // Build the user message for the branch
    const userMessage: SDKUserMessage = {
      type: "user",
      uuid: randomUUID(),
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: buildUserMessageContent(prompt, attachments),
      },
    };
    this.abortController = new AbortController();

    async function* generateMessages() {
      yield userMessage;
    }

    this.addNewMessage(userMessage);
    this.summary = prompt;
    this.lastModifiedTime = Date.now();
    this.setBusyState(true);

    this.queryPromise = (async () => {
      try {
        const { thinkingLevel: _thinkingLevel, ...effectiveOptions } = this.buildEffectiveOptions();
        const options: SDKOptions = {
          ...effectiveOptions,
          abortController: this.abortController,
          // Branch-specific options: fork from source session at PARENT of branch point
          // This means the new message REPLACES the branch point message (edit behavior)
          resume: sourceSessionId,
          forkSession: true,
          ...(resumeAtUuid ? { resumeSessionAt: resumeAtUuid } : {}),
        };

        for await (const message of this.sdkClient.queryStream(
          generateMessages(),
          options
        )) {
          console.log(message);
          this.processIncomingMessage(message);
        }
      } catch (error) {
        console.error(`Error branching session:`, error);
        this.error = error instanceof Error ? error : String(error);
      } finally {
        this.queryPromise = null;
        this.setBusyState(false);
      }
    })();

    await this.queryPromise;
    this.lastModifiedTime = Date.now();
    console.log(`[Session] Branch complete, new session: ${this.sessionId}`);

    // Return branch metadata for the caller to store
    // resumeAtUuid is the parent of the branch point (or empty if branching from first message)
    return {
      newSessionId: this.sessionId,
      parentSessionId: sourceSessionId,
      branchPointMessageUuid: branchAtMessageUuid,
      branchPointParentUuid: resumeAtUuid || undefined,
    } as BranchResult;
  }

  processIncomingMessage(message: SDKMessage): void {
    console.log("Received message:", message);

    if (message.session_id) {
      this.updateSessionId(message.session_id);
    }

    this.addNewMessage(message);

    const rawTimestamp = (message as { timestamp?: unknown }).timestamp;
    const extracted = extractTimestamp(rawTimestamp);
    this.lastModifiedTime = extracted ?? Date.now();

    // Update high level state derived from system/result messages.
    if (message.type === "system") {
      if (message.subtype === "init") {
        this.setBusyState(true);
      }
    } else if (message.type === "result") {
      this.setBusyState(false);
    }
  }
  private getSessionStateSnapshot(): SessionStateSnapshot {
    // Strip out mcpServers and hooks as they may contain non-serializable objects
    // (MCP server instances, validator schemas with circular references, etc.)
    const options = this.buildEffectiveOptions();
    const { mcpServers: _mcpServers, hooks: _hooks, ...serializableOptions } = options;
    return {
      isBusy: this.busyState,
      isLoading: this.loadingState,
      options: serializableOptions as SessionSDKOptions,
    };
  }

  private createSessionStateMessage(update: SessionStateUpdate): OutcomingMessage {
    return {
      type: "session_state_changed",
      sessionId: this.sessionId,
      sessionState: update,
    };
  }

  private emitSessionStateChange(update: SessionStateUpdate): void {
    if (!update || Object.keys(update).length === 0) {
      return;
    }
    // TODO: debounce
    this.notifyClients("sessionStateChanged", this.createSessionStateMessage(update));
  }
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}
