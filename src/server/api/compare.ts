/**
 * Comparison demo API — one question, streamed per lane as NDJSON, multi-turn.
 *
 * POST /api/compare/:lane   body { question, sessionId, connectorIds? }
 *   lane ∈ modal | sandcastle | ana
 *   Response: application/x-ndjson, one JSON LaneEvent per line.
 * POST /api/compare/reset   body { sessionId }  — kill sandboxes + drop state.
 *
 * The frontend opens three :lane streams in parallel (one per column) and reuses
 * the same sessionId across turns so each lane continues its conversation.
 */
import { Router, type Request, type Response } from 'express'
import { getAuth } from '@clerk/express'
import { runSandboxLane, runMcpLane, runAnaLane, type LaneEvent } from '../comparison/lane-runner'
import { getCompareSession, dropCompareSession, listCompareSessions, type CompareSession } from '../comparison/sessions'
import { modalManager } from '../sandbox/modal-manager'
import { sandboxManager } from '../sandbox/sandcastle-manager'

const router = Router()

async function killSessionSandboxes(s: CompareSession): Promise<void> {
  if (s.modal.sandboxId) await modalManager.killSandbox(s.modal.sandboxId).catch(() => {})
  if (s.sandcastle.sandboxId) await sandboxManager.killSandbox(s.sandcastle.sandboxId).catch(() => {})
  // Ana chats are server-side; nothing to kill.
}

// Proactively reap sandboxes from abandoned sessions (closed tab / no reset).
// Backstops: Modal self-expires (~15m idle), Sandcastle reaps (~1h).
const SESSION_TTL_MS = 20 * 60 * 1000
const sweep = setInterval(() => {
  const now = Date.now()
  for (const [id, s] of listCompareSessions()) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      dropCompareSession(id)
      void killSessionSandboxes(s)
    }
  }
}, 5 * 60 * 1000)
sweep.unref?.()

router.post('/compare/reset', async (req: Request, res: Response) => {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const sessionId = (req.body?.sessionId ?? '').toString()
  const sess = sessionId ? dropCompareSession(sessionId) : undefined
  if (sess) await killSessionSandboxes(sess)
  res.json({ ok: true })
})

router.post('/compare/:lane', async (req: Request, res: Response) => {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const lane = req.params.lane
  const question = (req.body?.question ?? '').toString().trim()
  const sessionId = (req.body?.sessionId ?? '').toString() || `anon-${userId}`
  const connectorIds: number[] | undefined = Array.isArray(req.body?.connectorIds) ? req.body.connectorIds : undefined
  if (!question) {
    res.status(400).json({ error: 'question required' })
    return
  }

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const emit = (e: LaneEvent) => {
    res.write(JSON.stringify(e) + '\n')
    ;(res as Response & { flush?: () => void }).flush?.()
  }

  let aborted = false
  req.on('close', () => {
    aborted = true
  })

  const session = getCompareSession(sessionId)

  try {
    if (lane === 'modal') {
      await runSandboxLane({ backend: 'modal', question, emit, sess: session.modal })
    } else if (lane === 'sandcastle') {
      await runSandboxLane({ backend: 'sandcastle', question, emit, sess: session.sandcastle })
    } else if (lane === 'mcp') {
      await runMcpLane({ question, emit, sess: session.mcp })
    } else if (lane === 'ana') {
      await runAnaLane({ question, emit, sess: session.ana, connectorIds })
    } else {
      emit({ type: 'error', message: `unknown lane: ${lane}` })
    }
  } catch (e) {
    if (!aborted) emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  } finally {
    res.end()
  }
})

export default router
