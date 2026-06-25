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
import { runSandboxLane, runMcpLane, runAnaLane, compareSandboxManager, type LaneEvent } from '../comparison/lane-runner'
import { getCompareSession, dropCompareSession, listCompareSessions, type CompareSession } from '../comparison/sessions'
import { modalManager } from '../sandbox/modal-manager'

const router = Router()

async function killSessionSandboxes(s: CompareSession): Promise<void> {
  if (s.modal.sandboxId) await modalManager.killSandbox(s.modal.sandboxId).catch(() => {})
  if (s.sandcastle.sandboxId) await compareSandboxManager.killSandbox(s.sandcastle.sandboxId).catch(() => {})
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

// Flywheel: show the sandbox lane's pending ./library edits (the ontology the
// agent wrote this round) so the user can accept/reject before the next round.
router.get('/compare/ontology', async (req: Request, res: Response) => {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const sessionId = (req.query?.sessionId ?? '').toString()
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId required' })
    return
  }
  const sandboxId = getCompareSession(sessionId).sandcastle.sandboxId
  if (!sandboxId) {
    res.json({ hasChanges: false, files: [], rawDiff: '' })
    return
  }
  try {
    const d = await compareSandboxManager.diffLibrary(sandboxId)
    res.json({ hasChanges: d.hasChanges, files: d.diffs, rawDiff: d.rawDiff })
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// Flywheel: apply the user's accept/reject decision. Rejected files are deleted
// from the sandbox's ./library so the next round cannot benefit from them;
// accepted files stay (and the agent already filed them as an org patch).
router.post('/compare/ontology/decision', async (req: Request, res: Response) => {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const sessionId = (req.body?.sessionId ?? '').toString()
  const reject: string[] = Array.isArray(req.body?.reject) ? req.body.reject.map((s: unknown) => String(s)) : []
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId required' })
    return
  }
  const sandboxId = getCompareSession(sessionId).sandcastle.sandboxId
  if (!sandboxId || reject.length === 0) {
    res.json({ ok: true, deleted: [] })
    return
  }
  try {
    const code = [
      'import os, json',
      `_targets = ${JSON.stringify(reject)}`,
      '_deleted = []',
      'for _n in _targets:',
      "  _p = _n if _n.startswith('library') else os.path.join('library', _n)",
      '  try:',
      '    os.remove(_p); _deleted.append(_n)',
      '  except Exception: pass',
      "print('__DELETED__' + json.dumps(_deleted))",
    ].join('\n')
    const r = await compareSandboxManager.executeCode(sandboxId, code)
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__DELETED__'))
    const deleted = line ? JSON.parse(line.slice('__DELETED__'.length)) : []
    res.json({ ok: true, deleted })
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// Reset the ontology: wipe the sandbox lane's local ./library AND reset the org
// Context Library by filing an all-deletions writeback patch (auto-approved when
// the org allows it; otherwise the patch is staged for review).
router.post('/compare/ontology/reset', async (req: Request, res: Response) => {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const sessionId = (req.body?.sessionId ?? '').toString()
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId required' })
    return
  }
  const sandboxId = getCompareSession(sessionId).sandcastle.sandboxId
  if (!sandboxId) {
    res.json({ ok: true, sandboxCleared: false, committed: false, message: 'no active sandbox' })
    return
  }
  try {
    // Clear the sandbox's local ./library (rm -rf ./library/*). The execute cwd
    // is SANDBOX_WORKDIR, so 'library' resolves to /sandbox/files/library.
    const code = [
      'import os, shutil',
      "if os.path.isdir('library'):",
      "  for _n in os.listdir('library'):",
      "    _p = os.path.join('library', _n)",
      '    shutil.rmtree(_p) if os.path.isdir(_p) else os.remove(_p)',
      "print('__CLEARED__')",
    ].join('\n')
    await compareSandboxManager.executeCode(sandboxId, code)

    const patch = await compareSandboxManager.createLibraryPatch(sandboxId, {
      title: 'Reset Context Library',
      description: 'Delete all committed Context Library files (Versus reset).',
    })
    let committed = patch.autoApproved
    if (!committed) {
      try {
        const r = await compareSandboxManager.approveLibraryChange(patch.patchId, patch.gitRef)
        committed = r.merged
      } catch {
        // Distinct-approver folder rules can reject self-approval; leave the patch
        // staged for human review rather than failing the whole reset.
        committed = false
      }
    }
    res.json({
      ok: true,
      sandboxCleared: true,
      committed,
      patch: {
        patchId: patch.patchId,
        patchNumber: patch.patchNumber,
        status: patch.status,
        autoApproved: patch.autoApproved,
      },
    })
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) })
  }
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
  // Flywheel rounds run as a FRESH conversation on the SAME sandbox, so any
  // speedup is attributable to accumulated ontology, not conversation memory.
  const fresh = req.body?.fresh === true
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

  // Heartbeat: all 4 lane streams multiplex over one HTTP/2 connection, so a
  // single long silent step (Modal cold-start, a big run_python, an Ana poll
  // gap) lets Cloudflare idle-timeout the whole connection and every lane dies
  // with "Load failed". A periodic ping keeps it alive; the client ignores it.
  const heartbeat = setInterval(() => {
    try {
      res.write('{"type":"ping"}\n')
      ;(res as Response & { flush?: () => void }).flush?.()
    } catch {
      // connection already gone
    }
  }, 15000)
  heartbeat.unref?.()

  let aborted = false
  req.on('close', () => {
    aborted = true
    clearInterval(heartbeat)
  })

  const session = getCompareSession(sessionId)

  // Fresh round: drop the conversation id (keep the sandbox + its ./library).
  if (fresh) {
    if (lane === 'modal') session.modal.resumeId = undefined
    else if (lane === 'sandcastle') session.sandcastle.resumeId = undefined
    else if (lane === 'mcp') session.mcp.resumeId = undefined
    else if (lane === 'ana') session.ana.chatId = undefined
  }

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
    clearInterval(heartbeat)
    res.end()
  }
})

export default router
