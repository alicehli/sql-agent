import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSetAtom } from 'jotai'
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
  useUser,
} from '@clerk/clerk-react'

import { ChatHeader } from '@/components/chat/chat-header'
import {
  PromptInput,
  type PromptContext,
  type AttachedFile,
} from '@/components/prompt-input/prompt-input'
import { MessagesPane } from '@/components/chat/messages-pane'
import { LeftSidebar } from '@/components/left-sidebar/left-sidebar'
import { SandboxFileBrowser } from '@/components/sandbox/sandbox-file-browser'
import { ConnectorsList } from '@/components/connectors/connectors-list'
import { ComparisonView } from '@/components/comparison/comparison-view'
import type { SessionSelectPayload } from '@/components/left-sidebar/types'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { useWebSocket } from '@/hooks/use-web-socket'
import type { UserMessage } from '@/types/session'

import { navigateTo } from '@/lib/route'
import { buildAttachmentPayloads } from '@/lib/attachment-utils'
import type { OutcomingMessage } from '@claude-agent-kit/server'
import { createSystemMessage } from '@/lib/chat-message-utils'
import { chatMessagesAtom, chatSessionInfoAtom } from '@/state/chat-atoms'
import {
  useChatSessionState,
  useOutcomingMessageHandler,
  useSelectChatSession,
  useChatSessionOptions,
} from '@/state/use-chat-session'

import { useProjectConfig } from '@/hooks/use-project-config'
import { useCommandRegistry } from '@/hooks/use-command-registry'
import { useSandboxRefresh } from '@/hooks/use-sandbox-refresh'
import { useWorldlines } from '@/hooks/use-worldlines'
import { useInlineEditing } from '@/hooks/use-inline-editing'
import { usePlaybookRunner } from '@/hooks/use-playbook-runner'

type ServerMessage =
  | { type: 'connected'; message?: string }
  | { type: 'error'; error?: string; code?: string }
  | OutcomingMessage
  | Record<string, unknown>

function isOutcomingServerMessage(
  payload: ServerMessage,
): payload is OutcomingMessage {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const type = (payload as { type?: unknown }).type
  if (typeof type !== 'string') {
    return false
  }

  return (
    type === 'message_added' ||
    type === 'messages_updated' ||
    type === 'session_state_changed'
  )
}

function App() {
  const { user, isLoaded: isUserLoaded } = useUser()
  const { messages, sessionId, sessionInfo } = useChatSessionState()
  const setMessages = useSetAtom(chatMessagesAtom)
  const setSessionInfo = useSetAtom(chatSessionInfoAtom)
  const { isBusy, isLoading, options } = sessionInfo
  const permissionMode = options.permissionMode ?? 'default'
  const thinkingLevel = options.thinkingLevel ?? 'off'
  const reportMode = options.reportMode === true
  const selectChatSession = useSelectChatSession()
  const handleOutcomingMessage = useOutcomingMessageHandler()

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])

  // Comparison demo route (/compare) — set after mount to avoid SSR mismatch
  const [route, setRoute] = useState<'chat' | 'compare'>('chat')
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.pathname === '/compare') {
      setRoute('compare')
    }
  }, [])

  // Extract project config
  const { projectId } = useProjectConfig()

  // Extract command registry
  const commandRegistry = useCommandRegistry()

  // Extract sandbox refresh logic
  const {
    fileRefreshTrigger,
    toolsUsedThisTurnRef,
    triggerDebouncedFileRefresh,
    triggerImmediateFileRefresh,
    clearToolsUsedThisTurn,
  } = useSandboxRefresh()

  // Extract worldlines logic
  const { worldlines, handleWorldlineNavigate, refreshWorldlines } = useWorldlines({
    sessionId,
    projectId,
    selectChatSession,
  })

  // Keep a ref to the current sessionId for use in callbacks (avoids stale closure issues)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Ref for sendBranchMessage to break circular dependency with handleServerMessage
  const sendBranchMessageRef = useRef<((sourceSessionId: string, branchAtMessageUuid: string, content: string) => void) | null>(null)

  // When sessionId changes to a non-null value (new session started), refresh sidebar
  useEffect(() => {
    if (sessionId) {
      window.dispatchEvent(new CustomEvent('refresh-sessions'))
    }
  }, [sessionId])

  const sessionMessages = useMemo<UserMessage[]>(() => {
    return messages.map((message) => ({
      type: message.type,
      content: message.content.map((part) => {
        const block = part.content
        if (block.type === 'text') {
          return {
            content: {
              type: 'text',
              text: block.text ?? '',
            },
          }
        }
        if (block.type === 'tool_result') {
          const resultContent = block.content
          if (typeof resultContent === 'string') {
            return {
              content: {
                type: 'text',
                text: resultContent,
              },
            }
          }
        }
        return { content: undefined }
      }),
    }))
  }, [messages])

  const handleAddFiles = useCallback((files: FileList) => {
    setAttachedFiles((previous) => [
      ...previous,
      ...Array.from(files).map((file) => ({ file })),
    ])
  }, [])

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles((previous) =>
      previous.filter((_, fileIndex) => fileIndex !== index),
    )
  }, [])

  const handleSessionSelect = useCallback(
    ({ sessionId: nextSessionId, projectId }: SessionSelectPayload) => {
      if (nextSessionId === sessionId) {
        return
      }
      selectChatSession({ sessionId: nextSessionId, projectId })
      // Force refresh worldlines to ensure they're fetched for the new session
      // This handles cases where the useEffect might not trigger due to timing
      refreshWorldlines()
    },
    [selectChatSession, sessionId, refreshWorldlines],
  )

  const supportsSpeechRecognition = useMemo(() => {
    if (typeof window === 'undefined') {
      return false
    }
    const candidate = window as unknown as Record<string, unknown>
    return (
      'SpeechRecognition' in candidate ||
      'webkitSpeechRecognition' in candidate
    )
  }, [])

  const safeFocus = useCallback((element: HTMLElement) => {
    try {
      element.focus({ preventScroll: true })
    } catch {
      element.focus()
    }
  }, [])

  const promptContext = useMemo<PromptContext>(
    () => ({
      commandRegistry,
      safeFocus,
      supportsSpeechRecognition,
    }),
    [commandRegistry, safeFocus, supportsSpeechRecognition],
  )

  const websocketUrl = useMemo(() => {
    if (typeof window === 'undefined') {
      return null
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    return `${protocol}://${host}/ws`
  }, [])

  const handleServerMessage = useCallback(
    (raw: ServerMessage) => {
      if (raw.type === 'connected') {
        return
      }

      if (raw.type === 'branched') {
        const newSessionId = raw.newSessionId as string

        if (newSessionId && projectId) {
          // Navigate to the new branch - metadata was already saved server-side
          navigateTo(
            `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(newSessionId)}`,
          )
          selectChatSession({ sessionId: newSessionId, projectId })
          // Force refresh worldlines after session switch to ensure they're fetched
          // after messages load (same pattern as handleSessionSelect)
          refreshWorldlines()
        }
        return
      }

      // Handle AI-initiated branch via create_worldline tool
      if (raw.type === 'pending_branch') {
        const { sourceSessionId, branchAtMessageUuid, content } = raw as {
          sourceSessionId: string
          branchAtMessageUuid: string
          content: string
        }

        // Clear messages to branch point (same as UI flow in use-inline-editing.ts)
        setMessages((prev) => {
          const branchIndex = prev.findIndex((m) => m.id === branchAtMessageUuid)
          // Not found: leave the conversation untouched rather than wiping it.
          if (branchIndex === -1) return prev
          // Keep messages before the branch point (empty when branching from the first).
          return prev.slice(0, branchIndex)
        })

        // Small delay to let original session fully release MCP server resources
        setTimeout(() => {
          sendBranchMessageRef.current?.(sourceSessionId, branchAtMessageUuid, content)
        }, 500)
        return
      }

      // Refresh files when sandbox snapshot is restored (e.g., switching worldlines)
      if (raw.type === 'sandbox_changed') {
        const wasRestored = (raw as { wasRestored?: boolean }).wasRestored
        if (wasRestored) {
          triggerImmediateFileRefresh()
        }
        return
      }

      // Trigger targeted refresh when assistant turn completes
      if (raw.type === 'turn_complete') {
        const toolsUsed = toolsUsedThisTurnRef.current

        // Only refresh files if sandbox tools were used
        if (toolsUsed.has('sandbox')) {
          triggerImmediateFileRefresh()
        }

        // Only refresh playbooks if playbook tools were used
        if (toolsUsed.has('playbooks')) {
          window.dispatchEvent(new CustomEvent('refresh-playbooks'))
        }

        // Refresh sessions list (catches renames, new sessions, etc.)
        window.dispatchEvent(new CustomEvent('refresh-sessions'))

        // Clear for next turn
        clearToolsUsedThisTurn()
        return
      }

      if (raw.type === 'error') {
        const errorMessage =
          raw.error ??
          'An unknown error occurred while communicating with the server.'
        setMessages((previous) => [
          ...previous,
          createSystemMessage(`Error: ${errorMessage}`),
        ])
        setSessionInfo((previous) => ({
          ...previous,
          isBusy: false,
          isLoading: false,
        }))
        return
      }

      // Track tool usage from message_added events
      if (raw.type === 'message_added') {
        const message = (
          raw as {
            message?: {
              type?: string
              message?: { content?: Array<{ type?: string; name?: string }> }
            }
          }
        ).message
        if (message?.type === 'assistant' && message?.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.name) {
              // Categorize tool by prefix
              if (block.name.startsWith('mcp__sandbox__')) {
                toolsUsedThisTurnRef.current.add('sandbox')
                // Trigger debounced refresh for intermediate preview
                triggerDebouncedFileRefresh()
              } else if (block.name.startsWith('mcp__playbooks__')) {
                toolsUsedThisTurnRef.current.add('playbooks')
                // Dispatch immediately for playbooks since they should appear right away
                window.dispatchEvent(new CustomEvent('refresh-playbooks'))
              }
            }
          }
        }
      }

      if (isOutcomingServerMessage(raw)) {
        handleOutcomingMessage(raw)
      }
    },
    [
      handleOutcomingMessage,
      setMessages,
      setSessionInfo,
      projectId,
      selectChatSession,
      triggerDebouncedFileRefresh,
      triggerImmediateFileRefresh,
      clearToolsUsedThisTurn,
      toolsUsedThisTurnRef,
      refreshWorldlines,
    ],
  )

  const {
    isConnected,
    sandboxId,
    sendMessage,
    setSDKOptions,
    disconnect,
    reconnect,
    sendBranchMessage,
  } = useWebSocket({
    url: websocketUrl,
    userId: user?.id,
    onMessage: handleServerMessage,
  })

  // Update ref for use in handleServerMessage (breaks circular dependency)
  useEffect(() => {
    sendBranchMessageRef.current = sendBranchMessage
  }, [sendBranchMessage])

  const { setPermissionMode, setThinkingLevel, setReportMode } =
    useChatSessionOptions(setSDKOptions)

  const handleInterrupt = useCallback(() => {
    sendMessage({ type: 'interrupt' })
    setSessionInfo((previous) => ({
      ...previous,
      isBusy: false,
      isLoading: false,
    }))
  }, [sendMessage, setSessionInfo])

  // Extract playbook runner logic
  const { handleNewSession } = usePlaybookRunner({
    disconnect,
    reconnect,
    selectChatSession,
    sendMessage,
  })

  // Extract inline editing logic
  const {
    editingMessageId,
    editingContent,
    handleStartEdit,
    handleCancelEdit,
    handleSubmitEdit,
  } = useInlineEditing({
    messages,
    sessionId,
    sendBranchMessage,
  })

  // isStreaming is only for actual chat activity, not session loading
  const isStreaming = isBusy

  const handlePromptSubmit = useCallback(
    async (message: string, attachments: AttachedFile[]) => {
      const trimmed = message.trim()
      if (!trimmed || !isConnected) {
        return
      }

      let attachmentPayloads: import('@claude-agent-kit/messages').AttachmentPayload[] | undefined
      if (attachments.length > 0) {
        const serialized = await buildAttachmentPayloads(attachments)
        if (serialized.length > 0) {
          attachmentPayloads = serialized
        }
      }

      // Use ref to get the latest sessionId (avoids stale closure after "New Session")
      const currentSessionId = sessionIdRef.current

      sendMessage({
        type: 'chat',
        content: trimmed,
        sessionId: currentSessionId,
        attachments: attachmentPayloads,
      })
      setSessionInfo((previous) => ({
        ...previous,
        isBusy: true,
      }))
      setAttachedFiles([])
    },
    [isConnected, sendMessage, setAttachedFiles, setSessionInfo],
  )

  // Show spinner while Clerk loads - use inline styles to avoid FOUC
  if (!isUserLoaded) {
    return (
      <div
        style={{
          display: 'flex',
          height: '100svh',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'white',
        }}
      >
        <div
          style={{
            width: '24px',
            height: '24px',
            border: '2px solid #e2e8f0',
            borderTopColor: '#64748b',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div className="flex h-svh w-full flex-col">
      {/* Sign-in screen for unauthenticated users */}
      <SignedOut>
        <div className="flex h-full w-full flex-col items-center justify-center bg-white">
          <div className="flex flex-col items-center gap-8">
            <div className="flex flex-col items-center gap-3">
              <h1
                className="text-4xl font-semibold text-slate-900 tracking-tight"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Sidekick
              </h1>
              <p
                className="text-slate-500 text-sm"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Agent Data
              </p>
            </div>
            <SignInButton mode="modal">
              <button
                className="px-8 py-3 bg-slate-900 text-white text-sm font-medium rounded hover:bg-slate-800 transition-colors"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Sign in →
              </button>
            </SignInButton>
            <p
              className="text-slate-400 text-xs mt-8"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              sql · python · visualizations
            </p>
          </div>
        </div>
      </SignedOut>

      {/* Main app for authenticated users */}
      <SignedIn>
        {route === 'compare' ? (
          <ComparisonView />
        ) : (
        <>
        <ChatHeader />

        <main className="flex-1 overflow-hidden px-4 py-4">
          <ResizablePanelGroup
            direction="horizontal"
            className="flex h-full w-full overflow-hidden gap-2"
          >
            <ResizablePanel
              defaultSize={13}
              minSize={10}
              maxSize={22}
              className="max-w-[280px] min-w-[180px]"
            >
              <div className="h-full border bg-white">
                <LeftSidebar
                  selectedSessionId={sessionId}
                  onSessionSelect={handleSessionSelect}
                  onNewSession={handleNewSession}
                  userButton={
                    <div className="flex items-center gap-3">
                      <UserButton afterSignOutUrl="/" />
                      {user && (
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium truncate">
                            {user.fullName || user.firstName || 'User'}
                          </span>
                          <span className="text-xs text-muted-foreground truncate">
                            {user.primaryEmailAddress?.emailAddress}
                          </span>
                        </div>
                      )}
                    </div>
                  }
                />
              </div>
            </ResizablePanel>
            <ResizableHandle className="w-0 bg-transparent" />
            <ResizablePanel
              defaultSize={50}
              minSize={35}
              maxSize={65}
              className="flex h-full flex-col"
            >
              <div className="h-full border bg-white flex flex-col">
                <MessagesPane
                  messages={messages}
                  isStreaming={isStreaming}
                  isLoading={isLoading}
                  worldlines={worldlines}
                  currentSessionId={sessionId}
                  onWorldlineNavigate={handleWorldlineNavigate}
                  editingMessageId={editingMessageId}
                  editingContent={editingContent}
                  onStartEdit={handleStartEdit}
                  onCancelEdit={handleCancelEdit}
                  onSubmitEdit={handleSubmitEdit}
                />
                <div className="shrink-0 border-t px-6 py-4">
                  <PromptInput
                    messages={sessionMessages}
                    permissionMode={permissionMode}
                    onPermissionModeChange={setPermissionMode}
                    isBusy={isStreaming}
                    usageData={{ totalTokens: 0, totalCost: 0, contextWindow: 0 }}
                    thinkingLevel={thinkingLevel}
                    onThinkingLevelChange={setThinkingLevel}
                    reportMode={reportMode}
                    onReportModeChange={setReportMode}
                    availableModels={[]}
                    currentModel={null}
                    selection={null}
                    onInterrupt={handleInterrupt}
                    onSubmit={handlePromptSubmit}
                    context={promptContext}
                    placeholder={
                      isConnected ? 'Ask anything...' : 'Connecting...'
                    }
                    onListFiles={async () => []}
                    onRemoveFile={handleRemoveFile}
                    onAddFiles={handleAddFiles}
                    attachedFiles={attachedFiles}
                    includeSelection={false}
                    onToggleIncludeSelection={() => {}}
                    onModelSelected={() => {}}
                  />
                </div>
              </div>
            </ResizablePanel>
            <ResizableHandle className="w-0 bg-transparent" />
            <ResizablePanel
              defaultSize={37}
              minSize={20}
              maxSize={50}
              className="min-w-[280px]"
            >
              <div className="h-full border bg-white flex flex-col">
                <ConnectorsList />
                <div className="min-h-0 flex-1 border-t">
                  <SandboxFileBrowser
                    sandboxId={sandboxId}
                    refreshTrigger={fileRefreshTrigger}
                    sessionId={sessionId}
                  />
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
        </>
        )}
      </SignedIn>
    </div>
  )
}

export default App
