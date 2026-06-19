import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@claude-agent-kit/messages'
import {
  createSystemMessage,
  sortMessages,
  updateToolResult,
} from '../chat-message-utils'

describe('createSystemMessage', () => {
  it('produces a unique id per call so React keys never collide', () => {
    const a = createSystemMessage('Error: one')
    const b = createSystemMessage('Error: two')
    expect(a.id).not.toBe(b.id)
    expect(a.id.startsWith('system-')).toBe(true)
    expect(b.id.startsWith('system-')).toBe(true)
  })

  it('wraps the text in a single text content part', () => {
    const message = createSystemMessage('hello')
    expect(message.type).toBe('user')
    expect(message.content).toHaveLength(1)
    expect(message.content[0]!.content).toEqual({ type: 'text', text: 'hello' })
  })
})

describe('sortMessages', () => {
  it('orders messages by ascending timestamp without mutating the input', () => {
    const input: ChatMessage[] = [
      { id: 'b', type: 'assistant', timestamp: 30, content: [] },
      { id: 'a', type: 'user', timestamp: 10, content: [] },
      { id: 'c', type: 'assistant', timestamp: 20, content: [] },
    ]
    const sorted = sortMessages(input)
    expect(sorted.map((m) => m.id)).toEqual(['a', 'c', 'b'])
    // original array is untouched
    expect(input.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('updateToolResult', () => {
  const baseMessage: ChatMessage = {
    id: 'm1',
    type: 'assistant',
    timestamp: 1,
    content: [
      {
        content: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        toolResult: undefined,
      },
    ],
  }

  it('attaches the result to the matching tool_use and returns a new object', () => {
    const result = {
      type: 'tool_result' as const,
      tool_use_id: 'tool-1',
      content: 'ok',
      is_error: false,
    }
    const updated = updateToolResult(baseMessage, 'tool-1', result)
    expect(updated).not.toBe(baseMessage)
    expect(updated.content[0]!.toolResult).toBe(result)
    // original is not mutated
    expect(baseMessage.content[0]!.toolResult).toBeUndefined()
  })

  it('leaves parts unchanged when no tool_use id matches', () => {
    const result = {
      type: 'tool_result' as const,
      tool_use_id: 'other',
      content: 'x',
      is_error: false,
    }
    const updated = updateToolResult(baseMessage, 'other', result)
    expect(updated.content[0]!.toolResult).toBeUndefined()
  })
})
