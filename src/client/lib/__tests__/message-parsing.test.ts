import { describe, expect, it } from 'vitest'
import type { MessageContentBlock } from '@claude-agent-kit/messages'
import { parseUserFacingContent } from '../message-parsing'

function text(value: string): MessageContentBlock {
  return { type: 'text', text: value } as MessageContentBlock
}

describe('parseUserFacingContent', () => {
  it('returns null for non-text blocks', () => {
    const block = { type: 'tool_use', id: 'x', name: 'Bash', input: {} } as MessageContentBlock
    expect(parseUserFacingContent(block)).toBeNull()
  })

  it('recognizes the interrupt sentinel and maps it to a friendly label', () => {
    expect(parseUserFacingContent(text('[Request interrupted by user]'))).toEqual({
      type: 'interrupt',
      message: '[Request interrupted by user]',
      friendlyMessage: 'Interrupted',
    })
  })

  it('treats plain text as text and flags slash-prefixed input', () => {
    expect(parseUserFacingContent(text('hello world'))).toEqual({
      type: 'text',
      text: 'hello world',
      isSlashCommand: false,
    })
    expect(parseUserFacingContent(text('/help'))).toEqual({
      type: 'text',
      text: '/help',
      isSlashCommand: true,
    })
  })

  it('extracts a slash command from command-name/args tags', () => {
    const parsed = parseUserFacingContent(
      text('<command-name>compact</command-name><command-args>now</command-args>'),
    )
    expect(parsed).toEqual({
      type: 'text',
      text: 'compact now',
      isSlashCommand: false,
    })
  })
})
