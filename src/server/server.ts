import { createServer as createHttpServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import type { ViteDevServer } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'
import { clerkMiddleware } from '@clerk/express'

import { SimpleClaudeAgentSDKClient, configureSessionMcpServers, setOntologyContext } from '@claude-agent-kit/server'
import { WebSocketHandler } from '@claude-agent-kit/websocket'
import { registerApiRoutes } from './api'
import { registerRoutes } from './routes'
import { sandboxManager } from './sandbox/sandcastle-manager'
import { createSandboxMcpServer, setSandboxProvider } from './tools/sandbox-tools'
import { createPlaybookMcpServer, setCurrentPlaybookUser } from './tools/playbook-tools'
import { createBranchMcpServer, getPendingBranchDirection, setPendingBranchDirection } from './tools/branch-tools'
import { saveBranchMetadata, loadBranchMetadata, getWorldlineSiblings } from './api/branches'
import { getCurrentProjectId } from './api/projects'
import { saveSnapshot, findLatestSnapshotForSession, loadSnapshotByMessageUuid } from './sandbox/snapshot-storage'
import { upsertSession, createBranch, getSession, setSessionSandbox, setSessionSandboxStatus } from './db/app-db'

// Fallback project ID for unauthenticated requests (shouldn't happen in production)
const FALLBACK_PROJECT_ID = process.env.PROJECT_ID || 'default'

export interface CreateServerOptions {
  root?: string
}

// Track sandbox and user per WebSocket connection
const wsSandboxMap = new Map<WebSocket, string>()
const wsUserMap = new Map<WebSocket, string>()

// Track sandbox switching state per WebSocket - prevents race conditions
const wsSandboxSwitchingPromise = new Map<WebSocket, Promise<void>>()

// The active connection for the sandbox provider. Per-connection session/sandbox
// state lives in the wsSessionMap / wsSandboxMap maps (the single source of truth);
// this is just the pointer to whose turn is currently being processed.
let currentWs: WebSocket | null = null

// Ontology/context (ANA.md + .tql index) is org-level and stable, so load it
// once per process from the first available sandbox and inject into the system prompt.
let ontologyLoaded = false
async function maybeLoadOntologyContext(sandboxId: string): Promise<void> {
  if (ontologyLoaded) return
  ontologyLoaded = true // optimistic; reset on failure so a later sandbox can retry
  try {
    const ctx = await sandboxManager.getOntologyContext(sandboxId)
    if (ctx) {
      setOntologyContext(ctx)
      console.log(`[Server] Injected ontology context (${ctx.length} chars) into system prompt`)
    } else {
      ontologyLoaded = false
    }
  } catch (err) {
    console.error('[Server] Failed to load ontology context:', err)
    ontologyLoaded = false
  }
}

export async function createServer(options: CreateServerOptions = {}) {
  const root = options.root ?? process.cwd()
  const isProduction = process.env.NODE_ENV === 'production'
  const base = process.env.BASE ?? '/'

  // Create in-process MCP servers for sandbox, SQL, playbook, and worldline tools
  const sandboxMcp = createSandboxMcpServer()
  const playbookMcp = createPlaybookMcpServer()
  const worldlinesMcp = createBranchMcpServer()

  // Configure session to use these MCP servers
  configureSessionMcpServers(
    {
      sandbox: sandboxMcp,
      playbooks: playbookMcp,
      worldlines: worldlinesMcp,
    },
    [
      // Sandbox tools (Python execution + files)
      'mcp__sandbox__run_python',
      'mcp__sandbox__run_command',
      'mcp__sandbox__write_file',
      'mcp__sandbox__read_file',
      'mcp__sandbox__list_files',
      // TextQL connector tools (SQL + TQL data access)
      'mcp__sandbox__list_connectors',
      'mcp__sandbox__query_connector',
      // Playbook tools
      'mcp__playbooks__create_playbook',
      'mcp__playbooks__update_playbook',
      // Worldline tools
      'mcp__worldlines__create_worldline',
    ]
  )

  // Set up lazy sandbox provider - creates sandbox only when tools need it
  // Uses getOrCreateSandbox for graceful degradation (resume or create new)
  setSandboxProvider(async () => {
    const ws = currentWs
    if (!ws) {
      return null
    }

    // The connection's sandbox (wsSandboxMap) is authoritative. If it already has one,
    // return it — idempotent, so repeated tool calls don't recreate or re-notify.
    const existing = wsSandboxMap.get(ws)
    if (existing) {
      void maybeLoadOntologyContext(existing)
      return existing
    }

    try {
      const sessionId = wsSessionMap.get(ws) ?? null
      let existingSandboxId: string | undefined
      let snapshotCommitSha: string | undefined

      // If we have a session, try to get existing sandbox and snapshot info
      if (sessionId) {
        const session = await getSession(sessionId)
        existingSandboxId = session?.sandboxId || undefined

        // Get latest snapshot commit SHA for validation
        const projectId = getCurrentProjectId()
        const latestSnapshot = await findLatestSnapshotForSession(projectId, sessionId)
        snapshotCommitSha = latestSnapshot?.commitSha
      }

      // Use getOrCreateSandbox for graceful degradation
      const { sandboxId, isNew, wasRestored } = await sandboxManager.getOrCreateSandbox(
        existingSandboxId,
        snapshotCommitSha
      )

      wsSandboxMap.set(ws, sandboxId)

      // Load the ontology/context once and inject it into the system prompt.
      void maybeLoadOntologyContext(sandboxId)

      // Update database with sandbox ID and status (if we have a session)
      if (sessionId) {
        await setSessionSandboxStatus(sessionId, sandboxId, 'running')
      }

      // Notify client with status flags
      ws.send(JSON.stringify({
        type: 'sandbox_changed',
        sandboxId,
        sessionId,
        isNew,
        wasRestored,
      }))

      return sandboxId
    } catch (error) {
      console.error('[Server] Failed to create sandbox on-demand:', error)
      return null
    }
  })

  const app = express()
  const httpServer = createHttpServer(app)
  const webSocketServer = new WebSocketServer({ server: httpServer })
  const sdkClient = new SimpleClaudeAgentSDKClient()
  const webSocketHandler = new WebSocketHandler(sdkClient, {
    thinkingLevel: 'default_on',
    // Provide worldlines for the 'branched' response to avoid race conditions
    getWorldlines: async (sessionId: string) => {
      const projectId = getCurrentProjectId()
      return getWorldlineSiblings(projectId, sessionId)
    },
    // Save branch metadata on the server BEFORE sending 'branched' event to client
    onBranchComplete: async (branchResult, ws) => {
      if (!branchResult.newSessionId || !branchResult.parentSessionId || !branchResult.branchPointMessageUuid) {
        return
      }
      const userId = wsUserMap.get(ws) || FALLBACK_PROJECT_ID

      // Save to app database
      try {
        await upsertSession(branchResult.newSessionId, userId)
        await createBranch(
          branchResult.newSessionId,
          branchResult.parentSessionId,
          branchResult.branchPointMessageUuid,
          branchResult.branchPointParentUuid
        )
      } catch (err) {
        console.error('[Server] Failed to save branch:', err)
      }

      // Also save to file-based storage for worldlines API
      const projectId = getCurrentProjectId()
      await saveBranchMetadata(projectId, {
        sessionId: branchResult.newSessionId,
        parentSessionId: branchResult.parentSessionId,
        branchPointMessageUuid: branchResult.branchPointMessageUuid,
        branchPointParentUuid: branchResult.branchPointParentUuid,
      })
    },

    // Auto-snapshot sandbox state when Claude finishes responding
    onTurnComplete: async ({ sessionId, lastMessageUuid }, ws) => {
      const sandboxId = wsSandboxMap.get(ws)
      if (!sandboxId) {
        return
      }

      const userId = wsUserMap.get(ws) || FALLBACK_PROJECT_ID

      try {
        // Load persisted messages to get the actual UUID (SDK uses different UUIDs in real-time vs disk)
        const { messages: persistedMessages } = await sdkClient.loadMessages(sessionId)

        // Extract session title from first user message (if not already set)
        let sessionTitle: string | undefined
        const session = await getSession(sessionId)
        if (!session?.title) {
          const firstUserMessage = persistedMessages.find(
            (msg) => (msg as { type?: string }).type === 'user'
          ) as { content?: Array<{ type?: string; text?: string }> } | undefined

          if (firstUserMessage?.content) {
            const textBlock = firstUserMessage.content.find((block) => block.type === 'text')
            if (textBlock?.text) {
              // Truncate to first 50 chars and clean up
              sessionTitle = textBlock.text.slice(0, 50).replace(/\n/g, ' ').trim()
              if (textBlock.text.length > 50) sessionTitle += '...'
            }
          }
        }

        // Register session in app database with title and sandbox status
        if (userId !== FALLBACK_PROJECT_ID) {
          try {
            await upsertSession(sessionId, userId, sessionTitle)
            await setSessionSandboxStatus(sessionId, sandboxId, 'running')
          } catch (err) {
            console.error('[Server] Failed to register session:', err)
          }
        }

        // Find the most recent assistant message
        let persistedUuid = lastMessageUuid
        for (let i = persistedMessages.length - 1; i >= 0; i--) {
          const msg = persistedMessages[i] as { type?: string; uuid?: string }
          if (msg.type === 'assistant' && msg.uuid) {
            persistedUuid = msg.uuid
            break
          }
        }

        // Create git snapshot in the sandbox
        const snapshot = await sandboxManager.createSnapshot(
          sandboxId,
          persistedUuid,
          `Turn complete - session ${sessionId}`
        )

        if (snapshot) {
          const projectId = getCurrentProjectId()
          await saveSnapshot(projectId, {
            commitSha: snapshot.commitSha,
            messageUuid: persistedUuid,
            sessionId,
            sandboxId,
            createdAt: snapshot.createdAt,
            description: snapshot.message,
          })
        }

        // Notify client that turn is complete (triggers file refresh)
        ws.send(JSON.stringify({ type: 'turn_complete', sessionId, sandboxId }))

        // Check for pending worldline branch from tool call
        const pendingDirection = getPendingBranchDirection()
        if (pendingDirection) {
          setPendingBranchDirection(null)

          // Find the SECOND-TO-LAST actual user message as branch point
          // We skip the last one because that's the "branch here" request itself
          // We want to branch at the message BEFORE it, replacing that with the new direction
          const actualUserMessages: string[] = []
          for (let i = 0; i < persistedMessages.length; i++) {
            const msg = persistedMessages[i] as {
              type?: string
              uuid?: string
              tool_use_result?: unknown
              isSynthetic?: boolean
              message?: { content?: Array<{type?: string, text?: string}> }
            }
            if (msg.type === 'user' && msg.uuid) {
              const isToolResult = !!msg.tool_use_result
              const isSynthetic = !!msg.isSynthetic
              // Also check if content contains tool_result blocks (another form of tool result)
              const hasToolResultContent = msg.message?.content?.some(b => b.type === 'tool_result')
              // Only count as real user message if has text content
              const textBlock = msg.message?.content?.find(b => b.type === 'text')
              const hasText = !!textBlock?.text

              // A real user message must have text content and not be a tool result
              if (hasText && !isToolResult && !isSynthetic && !hasToolResultContent) {
                actualUserMessages.push(msg.uuid)
              }
            }
          }

          // Need at least 2 user messages: one to branch at, one that requested the branch
          if (actualUserMessages.length >= 2) {
            // Branch at second-to-last user message (the one before the branch request)
            const branchAtMessageUuid = actualUserMessages[actualUserMessages.length - 2]
            console.log(`[Server] Pending branch: found ${actualUserMessages.length} user messages, branching at second-to-last (${branchAtMessageUuid.slice(0, 8)}...)`)
            // Tell client to initiate the branch (mimics UI click)
            ws.send(JSON.stringify({
              type: 'pending_branch',
              sourceSessionId: sessionId,
              branchAtMessageUuid,
              content: pendingDirection,
            }))
          } else {
            console.log(`[Server] Pending branch: not enough user messages (${actualUserMessages.length}), need at least 2`)
          }
        }
      } catch (error) {
        console.error('[Server] Failed to create snapshot:', error)
        // Still notify client even if snapshot failed
        ws.send(JSON.stringify({ type: 'turn_complete', sessionId, sandboxId }))
      }
    },
  })

  // Track which session each connection is currently using
  const wsSessionMap = new Map<WebSocket, string>()

  // Helper to try to reconnect to a session's existing sandbox
  // Uses getOrCreateSandbox for graceful degradation
  async function tryReconnectSessionSandbox(ws: WebSocket, sessionId: string): Promise<void> {
    try {
      const session = await getSession(sessionId)

      // Get latest snapshot for this session (or from parent branch)
      const projectId = getCurrentProjectId()
      let snapshot = await findLatestSnapshotForSession(projectId, sessionId)

      // If no snapshot for this session, check if it's a branch and restore from parent
      if (!snapshot) {
        const branchMeta = await loadBranchMetadata(projectId, sessionId)
        if (branchMeta?.branchPointParentUuid) {
          snapshot = await loadSnapshotByMessageUuid(projectId, branchMeta.branchPointParentUuid)
        }
      }

      // Use getOrCreateSandbox for graceful degradation
      // This handles: session with sandbox, session without sandbox, failed reconnect (creates new)
      const { sandboxId, isNew, wasRestored } = await sandboxManager.getOrCreateSandbox(
        session?.sandboxId || undefined,
        snapshot?.commitSha
      )

      wsSandboxMap.set(ws, sandboxId)

      // Update database with sandbox status
      await setSessionSandboxStatus(sessionId, sandboxId, 'running')

      // Notify client with status flags
      ws.send(JSON.stringify({
        type: 'sandbox_changed',
        sandboxId,
        sessionId,
        isNew,
        wasRestored,
      }))
    } catch (error) {
      console.error('[Server] Failed to reconnect sandbox:', error)
      // Clear the stale sandbox reference so a new one will be created on-demand
      try {
        await setSessionSandbox(sessionId, '')
      } catch {
        // Ignore cleanup errors
      }
      // Re-throw so the caller knows the switch failed
      throw error
    }
  }

  // Synchronized sandbox switch - ensures only one switch happens at a time per connection
  // and that all requests wait for the switch to complete
  async function switchSandboxForSession(ws: WebSocket, sessionId: string, userId: string): Promise<void> {
    // Wait for any in-progress switch to complete first
    const existingSwitch = wsSandboxSwitchingPromise.get(ws)
    if (existingSwitch) {
      try {
        await existingSwitch
      } catch {
        // Previous switch failed, continue with our switch
      }
    }

    // Use a deferred pattern to avoid referencing switchPromise in its own initializer
    let resolveSwitch: () => void
    let rejectSwitch: (err: Error) => void
    const switchPromise = new Promise<void>((resolve, reject) => {
      resolveSwitch = resolve
      rejectSwitch = reject
    })

    // Track the promise so other requests can wait for it
    wsSandboxSwitchingPromise.set(ws, switchPromise)

    try {
      await upsertSession(sessionId, userId)
      await tryReconnectSessionSandbox(ws, sessionId)
      resolveSwitch!()
    } catch (err) {
      rejectSwitch!(err as Error)
      throw err
    } finally {
      // Clean up - only delete if it's still our promise
      if (wsSandboxSwitchingPromise.get(ws) === switchPromise) {
        wsSandboxSwitchingPromise.delete(ws)
      }
    }
  }

  webSocketServer.on('connection', async (ws) => {
    // Handle WebSocket with the standard handler
    void webSocketHandler.onOpen(ws)

    // Point the provider at this connection. Per-connection session/sandbox state is
    // keyed by ws in the maps, so a fresh connection starts clean automatically (no
    // stale session/sandbox carried over from a previous connection).
    currentWs = ws

    // Send connected message WITHOUT sandbox ID (will be sent when session is known)
    const connectMessage = {
      type: 'connected',
      message: 'Connected to the Agent.',
      sandboxId: null, // Will be set when session is identified
    }
    ws.send(JSON.stringify(connectMessage))

    ws.on('message', async (data) => {
      // Set current connection context for sandbox provider
      currentWs = ws

      const text = typeof data === 'string' ? data : data.toString()

      // Parse message early to handle resume synchronously
      let parsed: { userId?: string; sessionId?: string; type?: string } | null = null
      try {
        parsed = JSON.parse(text) as { userId?: string; sessionId?: string; type?: string }
      } catch {
        // Not JSON - continue normally
      }

      // Register user for this connection
      if (parsed?.userId && !wsUserMap.has(ws)) {
        wsUserMap.set(ws, parsed.userId)
      }

      const userId = parsed?.userId || wsUserMap.get(ws)

      // Set current user for playbook tools
      if (userId) {
        setCurrentPlaybookUser(userId)
      }

      // Handle resume messages SYNCHRONOUSLY - block until sandbox switch completes
      // This is the key fix: we await the switch before forwarding to SDK
      if (parsed?.type === 'resume' && parsed.sessionId) {
        const resumeUserId = userId || FALLBACK_PROJECT_ID
        const previousSession = wsSessionMap.get(ws)

        // Update session tracking
        wsSessionMap.set(ws, parsed.sessionId)

        // Only switch sandbox if session actually changed
        if (previousSession !== parsed.sessionId) {
          try {
            await switchSandboxForSession(ws, parsed.sessionId, resumeUserId)
          } catch (err) {
            console.error('[Server] Failed to handle resume:', err)
          }
        }

        // Continue to forward resume to SDK for message history loading
        // (don't return early - SDK needs this message)
      }

      // For all other messages, wait for any in-progress sandbox switch first
      const switchPromise = wsSandboxSwitchingPromise.get(ws)
      if (switchPromise) {
        try {
          await switchPromise
        } catch {
          // Switch failed, continue anyway - sandbox provider will create new one
        }
      }

      // Track session for this connection
      if (parsed?.sessionId) {
        const previousSession = wsSessionMap.get(ws)
        if (previousSession !== parsed.sessionId) {
          wsSessionMap.set(ws, parsed.sessionId)
        }
      }

      // Create or reconnect to sandbox when we see a chat message
      // Uses getOrCreateSandbox for graceful degradation
      if (userId && parsed?.type === 'chat') {
        const chatSessionId = parsed.sessionId || null
        const chatUserId = userId
        const previousSession = wsSessionMap.get(ws)
        const currentSandboxId = wsSandboxMap.get(ws)

        // Check if we need to switch sandbox (session changed or no sandbox yet)
        const needsSwitch = !currentSandboxId || (chatSessionId && previousSession !== chatSessionId)

        if (needsSwitch && chatSessionId) {
          // Synchronously switch sandbox for this session
          try {
            await switchSandboxForSession(ws, chatSessionId, chatUserId)
          } catch (err) {
            console.error('[Server] Failed to switch sandbox for chat:', err)
          }
        } else if (!currentSandboxId && !chatSessionId) {
          // No session ID and no sandbox - create a new one
          try {
            const newSandboxId = await sandboxManager.createSandbox()
            wsSandboxMap.set(ws, newSandboxId)

            ws.send(JSON.stringify({
              type: 'sandbox_changed',
              sandboxId: newSandboxId,
              sessionId: chatSessionId,
              isNew: true,
              wasRestored: false,
            }))
          } catch (err) {
            console.error('[Server] Failed to create sandbox:', err)
          }
        }
      }

      // When branching, restore sandbox to the state AT the branch point
      if (parsed?.type === 'branch') {
        const branchMsg = parsed as { sourceSessionId?: string; branchAtMessageUuid?: string }
        if (branchMsg.sourceSessionId && branchMsg.branchAtMessageUuid) {
          const sandboxId = wsSandboxMap.get(ws)
          if (sandboxId) {
            try {
              const projectId = getCurrentProjectId()
              const branchPointUuid = branchMsg.branchAtMessageUuid

              let snapshot = await loadSnapshotByMessageUuid(projectId, branchPointUuid)

              // If not found, try the parent (branch point might be a user message)
              if (!snapshot) {
                const { messages: sourceMessages } = await sdkClient.loadMessages(branchMsg.sourceSessionId!)
                const branchPointMessage = sourceMessages.find(
                  (msg) => (msg as { uuid?: string }).uuid === branchPointUuid
                )
                const parentUuid = branchPointMessage
                  ? (branchPointMessage as { parentUuid?: string | null }).parentUuid || undefined
                  : undefined

                if (parentUuid) {
                  snapshot = await loadSnapshotByMessageUuid(projectId, parentUuid)
                }
              }

              if (snapshot) {
                await sandboxManager.restoreSnapshot(sandboxId, snapshot.commitSha)
              }
            } catch (err) {
              console.error('[Server] Failed to restore sandbox for branch:', err)
            }
          }
        }
      }

      webSocketHandler.onMessage(ws, text).catch((error) => {
        console.error('Failed to handle WebSocket message', error)
      })
    })

    ws.on('close', async () => {
      webSocketHandler.onClose(ws)

      // Pause sandbox when client disconnects to preserve state
      // Note: onTurnComplete already snapshots after each turn, so we just need to pause
      const closingSandboxId = wsSandboxMap.get(ws)
      const closingSessionId = wsSessionMap.get(ws)

      // Always clean up maps on close
      wsSandboxMap.delete(ws)
      wsSessionMap.delete(ws)
      wsUserMap.delete(ws)
      wsSandboxSwitchingPromise.delete(ws)

      // If this was the active connection, drop the pointer so the provider can't
      // operate on a dead connection. The per-ws maps were already deleted above.
      if (currentWs === ws) {
        currentWs = null
      }

      if (closingSandboxId) {
        try {
          // Pause sandbox using beta API (proper pause, not just disconnect)
          await sandboxManager.pauseSandbox(closingSandboxId)

          // Update database status to paused
          if (closingSessionId) {
            await setSessionSandboxStatus(closingSessionId, closingSandboxId, 'paused')
          }
        } catch {
          // Sandbox may have already timed out or been killed
          // Update status to unknown since we don't know its actual state
          if (closingSessionId) {
            try {
              await setSessionSandboxStatus(closingSessionId, closingSandboxId, 'unknown')
            } catch {
              // Ignore database errors during cleanup
            }
          }
        }
      }
    })

    ws.on('error', () => {
      // WebSocket errors are expected during disconnects
    })
  })

  // Add Clerk middleware for API routes (MUST come before Vite)
  app.use('/api', clerkMiddleware())

  // Register API routes BEFORE Vite middleware (so /api/* doesn't get caught by catch-all)
  await registerApiRoutes(app)

  let templateHtml = ''
  let vite: ViteDevServer | undefined

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
      base,
    })
    app.use(vite.middlewares)
  } else {
    templateHtml = await fs.readFile(path.resolve(root, 'dist/client/index.html'), 'utf-8')
    const compression = (await import('compression')).default
    const sirv = (await import('sirv')).default
    app.use(compression())
    app.use(base, sirv(path.resolve(root, 'dist/client'), { extensions: [] }))
  }

  registerRoutes(app, {
    base,
    isProduction,
    root,
    templateHtml,
    vite,
  })

  // Cleanup on server shutdown
  process.on('SIGINT', async () => {
    await sandboxManager.cleanup()
    process.exit(0)
  })

  return { app, vite, httpServer, webSocketServer }
}
