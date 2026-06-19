import { readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { parseSessionMessagesFromJsonl } from '@claude-agent-kit/server'

import { getProjectsRoot } from './projects'

export interface SessionSummary {
  id: string
  prompt: string
  firstMessageAt: number
  lastMessageAt: number
}

export interface SessionDetails {
  id: string
  messages: SDKMessage[]
}

export async function collectSessionSummaries(projectId: string): Promise<SessionSummary[] | null> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return []
  }

  const projectDir = path.join(projectsRoot, projectId)

  let entries: Dirent[]
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null
    }

    return []
  }

  // Collect all session IDs that are branches (have .branch.json files)
  const branchedSessionIds = new Set<string>()
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.branch.json')) {
      // Extract session ID from filename: {sessionId}.branch.json
      const sessionId = entry.name.slice(0, -'.branch.json'.length)
      branchedSessionIds.add(sessionId)
    }
  }

  // Build summaries concurrently: each file is read/parsed independently, and the
  // final list is sorted afterwards, so processing order doesn't matter.
  const sessionEntries = entries.filter((entry) => {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl')) {
      return false
    }
    // Skip branched sessions - they should only be accessible via worldline navigator
    return !branchedSessionIds.has(normalizeSessionId(entry.name))
  })

  const built = await Promise.all(
    sessionEntries.map((entry) =>
      buildSessionSummary(entry.name, path.join(projectDir, entry.name)),
    ),
  )

  const summaries = built.filter((s): s is SessionSummary => s !== null)
  summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  return summaries
}

export async function readSessionDetails(
  projectId: string,
  sessionId: string,
): Promise<SessionDetails | null> {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) {
    return { id: sessionId, messages: [] }
  }

  const normalizedId = normalizeSessionId(sessionId)
  const filePath = path.join(projectsRoot, projectId, `${normalizedId}.jsonl`)

  let fileContent: string
  try {
    fileContent = await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null
    }

    return { id: normalizedId, messages: [] }
  }

  const messages = parseSessionMessagesFromJsonl(fileContent)

  return { id: normalizedId, messages }
}

async function buildSessionSummary(fileName: string, filePath: string): Promise<SessionSummary | null> {
  let fileContent: string
  try {
    fileContent = await readFile(filePath, 'utf8')
  } catch {
    return null
  }

  // Check raw file for sidechain/warmup indicators
  // Look through first few lines for isSidechain or warmup content
  const lines = fileContent.split('\n').slice(0, 5)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>

      // Skip sidechain sessions
      if (raw.isSidechain === true) {
        return null
      }

      // Check for warmup content in user messages
      if (raw.type === 'user') {
        const msg = raw.message as { content?: string | unknown[] } | undefined
        let content = ''
        if (typeof msg?.content === 'string') {
          content = msg.content
        } else if (Array.isArray(msg?.content)) {
          const textBlock = msg.content.find((c: unknown) =>
            c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text'
          ) as { text?: string } | undefined
          content = textBlock?.text ?? ''
        }
        if (content.trim().toLowerCase() === 'warmup') {
          return null
        }
        break // Found first user message, stop checking
      }
    } catch {
      continue
    }
  }

  const records = parseSessionMessagesFromJsonl(fileContent)
  if (records.length === 0) {
    return null
  }

  const firstRecord = records[0]
  const lastRecord = records[records.length - 1]

  // Additional filter: Skip sessions that don't have any user messages
  const hasUserMessage = records.some(r => (r as Record<string, unknown>).type === 'user')
  if (!hasUserMessage) {
    return null
  }

  // Extract prompt from first user message for display
  const prompt = extractPrompt(firstRecord) ?? extractPrompt((firstRecord as { message?: unknown }).message) ?? ''

  const firstMessageAt =
    extractTimestamp((firstRecord as { firstMessageAt?: unknown }).firstMessageAt) ??
    extractTimestamp((firstRecord as { timestamp?: unknown }).timestamp)

  const lastMessageAt =
    extractTimestamp((lastRecord as { lastMessageAt?: unknown }).lastMessageAt) ??
    extractTimestamp((lastRecord as { timestamp?: unknown }).timestamp)

  if (firstMessageAt === null || lastMessageAt === null) {
    return null
  }

  return {
    id: normalizeSessionId(fileName),
    prompt,
    firstMessageAt,
    lastMessageAt,
  }
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const numeric = Number(value)
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

function extractPrompt(source: unknown): string | null {
  if (!source || typeof source !== 'object') {
    return null
  }

  const record = source as Record<string, unknown>

  if (typeof record.prompt === 'string' && record.prompt.trim().length > 0) {
    return record.prompt.trim()
  }

  if (typeof record.text === 'string' && record.text.trim().length > 0) {
    return record.text.trim()
  }

  const message = record.message as Record<string, unknown> | undefined
  if (message) {
    const fromMessage = extractPrompt(message)
    if (fromMessage) {
      return fromMessage
    }
  }

  const content = record.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const entry = item as Record<string, unknown>
      if (entry.type === 'text' && typeof entry.text === 'string') {
        const text = entry.text.trim()
        if (text.length > 0) {
          return text
        }
      }
    }
  }

  return null
}

function normalizeSessionId(value: string): string {
  return value.toLowerCase().endsWith('.jsonl') ? value.slice(0, -6) : value
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  )
}
