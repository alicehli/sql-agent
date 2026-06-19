import { useCallback, useState } from 'react'
import { useSetAtom } from 'jotai'
import type { ChatMessage } from '@claude-agent-kit/messages'
import { chatMessagesAtom, chatSessionInfoAtom } from '@/state/chat-atoms'

type UseInlineEditingOptions = {
  messages: ChatMessage[]
  sessionId: string | null
  sendBranchMessage: (
    sessionId: string,
    messageId: string,
    content: string,
  ) => void
}

export type InlineEditingState = {
  editingMessageId: string | null
  editingContent: string
  handleStartEdit: (messageId: string) => void
  handleCancelEdit: () => void
  handleSubmitEdit: (messageId: string, newContent: string) => void
}

/**
 * Branch editing state and handlers for inline message editing
 */
export function useInlineEditing({
  messages,
  sessionId,
  sendBranchMessage,
}: UseInlineEditingOptions): InlineEditingState {
  const setMessages = useSetAtom(chatMessagesAtom)
  const setSessionInfo = useSetAtom(chatSessionInfoAtom)

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState<string>('')

  // Handle starting inline edit for branching
  const handleStartEdit = useCallback(
    (messageId: string) => {
      // Find the message and extract its text content
      const message = messages.find((m) => m.id === messageId)
      if (!message) return

      // Extract text content from message parts
      let textContent = ''
      for (const part of message.content) {
        if (part.content.type === 'text' && part.content.text) {
          textContent = part.content.text
          break
        }
      }

      setEditingMessageId(messageId)
      setEditingContent(textContent)
    },
    [messages],
  )

  // Handle canceling inline edit
  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingContent('')
  }, [])

  // Handle submitting inline edit (creates branch)
  const handleSubmitEdit = useCallback(
    (messageId: string, newContent: string) => {
      if (!sessionId || !newContent.trim()) {
        handleCancelEdit()
        return
      }

      // Clear editing state
      setEditingMessageId(null)
      setEditingContent('')

      // Keep messages up to (but not including) the branch point
      // The message being branched from is being replaced, so hide it
      setMessages((prev) => {
        const branchIndex = prev.findIndex((m) => m.id === messageId)
        // Not found: leave the conversation untouched rather than wiping it.
        if (branchIndex === -1) {
          return prev
        }
        // Keep messages before the branch point (empty when branching from the first).
        return prev.slice(0, branchIndex)
      })

      // Send branch request
      sendBranchMessage(sessionId, messageId, newContent.trim())
      setSessionInfo((prev) => ({ ...prev, isBusy: true }))
    },
    [
      sessionId,
      sendBranchMessage,
      setSessionInfo,
      setMessages,
      handleCancelEdit,
    ],
  )

  return {
    editingMessageId,
    editingContent,
    handleStartEdit,
    handleCancelEdit,
    handleSubmitEdit,
  }
}
