/**
 * In-memory session state for the comparison demo, so each lane can hold a
 * multi-turn conversation: a live sandbox + the agent's resume id (A/B) and the
 * Ana chat_id (C). Keyed by a client-generated compare-session id.
 *
 * Process-local. Cleaned up by: explicit /api/compare/reset, an idle sweep (see
 * compare.ts), and the backends' own expiry (Modal timeout, Sandcastle reap).
 */
export interface LaneSession {
  sandboxId?: string
  resumeId?: string // Claude Agent SDK session id (lanes A/B)
  chatId?: string // Ana chat id (lane C)
}

export interface CompareSession {
  modal: LaneSession
  sandcastle: LaneSession
  mcp: LaneSession // lane C: Claude Agent SDK + TextQL MCP → Ana
  ana: LaneSession // lane D: direct Ana API
  lastActivity: number
}

const sessions = new Map<string, CompareSession>()

export function getCompareSession(id: string): CompareSession {
  let s = sessions.get(id)
  if (!s) {
    s = { modal: {}, sandcastle: {}, mcp: {}, ana: {}, lastActivity: Date.now() }
    sessions.set(id, s)
  } else {
    s.lastActivity = Date.now()
  }
  return s
}

export function dropCompareSession(id: string): CompareSession | undefined {
  const s = sessions.get(id)
  sessions.delete(id)
  return s
}

export function listCompareSessions(): Array<[string, CompareSession]> {
  return Array.from(sessions.entries())
}
