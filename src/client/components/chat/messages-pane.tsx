import { useEffect, useMemo, useRef, useState } from 'react'

import type { ChatMessage } from '@claude-agent-kit/messages'
import type { ClaudeMessageContext } from '../messages/types'

import { EmptyState } from '../messages/empty-state'
import { Message } from '../messages/message'
// BranchButton disabled: worldlines/branching dropped in the Sandcastle migration.
// import { BranchButton } from '../messages/message'
import { ThinkingIndicator } from './thinking-indicator'
import { WorldlineNavigator, type WorldlineBranch } from '../messages/worldline-navigator'

// Simple spinner for session loading - just the symbol, no text
const SPINNER_FRAMES = ['·', '✢', '*', '✶', '✻', '✽', '✻', '✶', '*', '✢'] as const

function LoadingSpinner() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length)
    }, 120)
    return () => clearInterval(interval)
  }, [])

  return (
    <span className="text-green-500 text-2xl font-mono">
      {SPINNER_FRAMES[frame]}
    </span>
  )
}

type MessagesPaneProps = {
  messages: ChatMessage[]
  isStreaming: boolean
  isLoading?: boolean  // True when switching sessions and loading messages
  worldlines?: WorldlineBranch[]  // All worldlines in the family
  currentSessionId?: string | null
  onWorldlineNavigate?: (sessionId: string) => void
  // Inline editing for branching
  editingMessageId?: string | null
  editingContent?: string
  onStartEdit?: (messageId: string) => void
  onCancelEdit?: () => void
  onSubmitEdit?: (messageId: string, newContent: string) => void
}

export function MessagesPane({
  messages,
  isStreaming,
  isLoading = false,
  worldlines = [],
  currentSessionId,
  onWorldlineNavigate,
  editingMessageId,
  editingContent,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
}: MessagesPaneProps) {
  // Build a map: messageUuid -> worldlines that branched at that point
  // We use branchPointParentUuid because this message exists in BOTH parent and branch sessions
  // This is crucial for showing the correct navigator at each branch point
  const branchesAtMessage = useMemo(() => {
    const map = new Map<string, WorldlineBranch[]>()

    // Group branches by their branch point PARENT (this UUID exists in both sessions)
    for (const wl of worldlines) {
      const keyUuid = wl.branchPointParentUuid || wl.branchPointMessageUuid
      if (keyUuid) {
        const existing = map.get(keyUuid) || []
        existing.push(wl)
        map.set(keyUuid, existing)
      }
    }

    // For each branch point, add the PARENT worldline (not root) as the first option
    // This ensures we navigate to the correct branch in nested scenarios
    for (const [, branches] of map) {
      // Find any branch's parent - they should all share the same parent at this branch point
      const firstBranch = branches[0]
      if (firstBranch?.parentSessionId) {
        const parentWorldline = worldlines.find(wl => wl.sessionId === firstBranch.parentSessionId)
        if (parentWorldline && !branches.some(b => b.sessionId === parentWorldline.sessionId)) {
          branches.unshift(parentWorldline)
        }
      }
    }

    return map
  }, [worldlines])

  // Build set of Skill tool_use IDs to hide their tool_result blocks
  const skillToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      if (message.type !== 'assistant') continue
      for (const part of message.content) {
        if (part.content.type === 'tool_use' && (part.content as any).name === 'Skill') {
          ids.add((part.content as any).id)
        }
      }
    }
    return ids
  }, [messages])
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null)
  const context = useMemo<ClaudeMessageContext>(() => {
    const open = (_filePath: string, _range?: { startLine?: number; endLine?: number }) => {
      // File opening is handled by the sandbox file browser
    }

    const openContent = async (
      content: string,
      title: string,
      preserveFocus: boolean,
    ): Promise<void> => {
      if (typeof window === 'undefined') {
        return
      }

      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const newWindow = window.open(url, '_blank', 'noopener,noreferrer')

      if (newWindow) {
        newWindow.document.title = title
        if (preserveFocus) {
          newWindow.blur()
          window.focus()
        }
      }

      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
    }

    return {
      fileOpener: { open, openContent },
      editingMessageId,
      onStartEdit,
      onCancelEdit,
      onSubmitEdit,
      skillToolUseIds,
    }
  }, [editingMessageId, onStartEdit, onCancelEdit, onSubmitEdit, skillToolUseIds])

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isStreaming])

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 overflow-x-hidden flex-col relative">
      <div className="flex flex-col gap-0">
        {messages.length === 0 ? (
          isLoading ? (
            // Show simple spinner when loading a session
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <LoadingSpinner />
            </div>
          ) : (
            <EmptyState context={context} />
          )
        ) : (
          messages.map((message, index) => {
            // Check if the PREVIOUS message is a branch point (for showing navigator below this user message)
            const prevMessage = index > 0 ? messages[index - 1] : null
            const branchesFromPrev = prevMessage ? branchesAtMessage.get(prevMessage.id) : null

            // Show controls below user messages
            const isUserMessage = message.type === 'user'
            const isEditing = editingMessageId === message.id
            const showBranchButton = isUserMessage && !isStreaming && onStartEdit !== undefined && !editingMessageId
            const showNavigator = branchesFromPrev && branchesFromPrev.length > 1 && currentSessionId && onWorldlineNavigate
            const showControls = isUserMessage && !isEditing && (showBranchButton || showNavigator)

            return (
              <div key={message.id}>
                <Message
                  message={message}
                  context={context}
                  isHighlighted={isStreaming && index === messages.length - 1}
                  editingContent={message.id === editingMessageId ? editingContent : undefined}
                />
                {/* Controls row below user messages: navigator + branch button */}
                {showControls && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginTop: '4px',
                    marginBottom: '8px',
                  }}>
                    {showNavigator && (
                      <WorldlineNavigator
                        branches={branchesFromPrev}
                        currentSessionId={currentSessionId}
                        onNavigate={onWorldlineNavigate}
                      />
                    )}
                    {/* Branch button disabled: worldlines/branching dropped in the
                        Sandcastle migration (sandbox snapshots are no-ops). */}
                    {/* {showBranchButton && onStartEdit && (
                      <BranchButton messageId={message.id} onStartEdit={onStartEdit} />
                    )} */}
                  </div>
                )}
              </div>
            )
          })
        )}
        {isStreaming ? (
          <div className="mt-2 flex h-7 items-center">
            <div className="flex items-center">
              <ThinkingIndicator size={14} />
            </div>
          </div>
        ) : null}
        <div ref={scrollAnchorRef} />
      </div>
    </div>
  )
}
