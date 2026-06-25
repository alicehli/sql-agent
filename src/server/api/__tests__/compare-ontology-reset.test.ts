import { beforeEach, describe, expect, it, vi } from 'vitest'

// Shared mock fns, hoisted so the vi.mock factories below can close over them.
const h = vi.hoisted(() => ({
  getAuth: vi.fn(),
  getCompareSession: vi.fn(),
  executeCode: vi.fn(),
  createLibraryPatch: vi.fn(),
  approveLibraryChange: vi.fn(),
}))

vi.mock('@clerk/express', () => ({ getAuth: h.getAuth }))

// compareSandboxManager lives in lane-runner; stub the lane entrypoints the
// router also imports so the module loads.
vi.mock('../../comparison/lane-runner', () => ({
  runSandboxLane: vi.fn(),
  runMcpLane: vi.fn(),
  runAnaLane: vi.fn(),
  compareSandboxManager: {
    executeCode: h.executeCode,
    createLibraryPatch: h.createLibraryPatch,
    approveLibraryChange: h.approveLibraryChange,
    killSandbox: vi.fn(),
    diffLibrary: vi.fn(),
  },
}))

vi.mock('../../comparison/sessions', () => ({
  getCompareSession: h.getCompareSession,
  dropCompareSession: vi.fn(),
  listCompareSessions: vi.fn(() => []),
}))

vi.mock('../../sandbox/modal-manager', () => ({
  modalManager: { killSandbox: vi.fn() },
}))

const { default: router } = await import('../compare')

type Handler = (req: unknown, res: unknown) => Promise<void>

function findHandler(method: string, path: string): Handler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layer = (router as any).stack.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (l: any) => l.route?.path === path && l.route?.methods?.[method]
  )
  if (!layer) throw new Error(`route ${method} ${path} not found`)
  const stack = layer.route.stack
  return stack[stack.length - 1].handle as Handler
}

function mockRes() {
  const res: {
    statusCode: number
    body?: unknown
    status: ReturnType<typeof vi.fn>
    json: ReturnType<typeof vi.fn>
  } = {
    statusCode: 200,
    status: vi.fn((c: number) => {
      res.statusCode = c
      return res
    }),
    json: vi.fn((b: unknown) => {
      res.body = b
      return res
    }),
  }
  return res
}

const handler = findHandler('post', '/compare/ontology/reset')

const PATCH = {
  patchId: 'patch-1',
  patchNumber: 7,
  status: 'open',
  gitRef: 'deadbeef',
  hasConflicts: false,
  autoApproved: true,
  rawDiff: '',
}

describe('POST /compare/ontology/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.getAuth.mockReturnValue({ userId: 'user-1' })
    h.getCompareSession.mockReturnValue({ sandcastle: { sandboxId: 'sb-1' } })
    h.executeCode.mockResolvedValue({ stdout: '__CLEARED__', stderr: '', exitCode: 0 })
    h.createLibraryPatch.mockResolvedValue({ ...PATCH })
    h.approveLibraryChange.mockResolvedValue({ merged: true, approvalCount: 1, requiredApprovals: 1 })
  })

  it('returns 401 when unauthenticated', async () => {
    h.getAuth.mockReturnValue({})
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(h.executeCode).not.toHaveBeenCalled()
  })

  it('no active sandbox -> ok with nothing cleared/committed, no sandbox calls', async () => {
    h.getCompareSession.mockReturnValue({ sandcastle: {} })
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(res.body).toMatchObject({ ok: true, sandboxCleared: false, committed: false })
    expect(h.executeCode).not.toHaveBeenCalled()
    expect(h.createLibraryPatch).not.toHaveBeenCalled()
  })

  it('clears ./library and files a deletion patch when a sandbox exists', async () => {
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(h.executeCode).toHaveBeenCalledTimes(1)
    const [sandboxId, code] = h.executeCode.mock.calls[0]
    expect(sandboxId).toBe('sb-1')
    expect(code).toContain("os.listdir('library')")
    expect(h.createLibraryPatch).toHaveBeenCalledWith(
      'sb-1',
      expect.objectContaining({ title: 'Reset Context Library' })
    )
    expect(res.body).toMatchObject({ ok: true, sandboxCleared: true })
  })

  it('auto-approved patch -> committed true, no approve call', async () => {
    h.createLibraryPatch.mockResolvedValue({ ...PATCH, autoApproved: true })
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(h.approveLibraryChange).not.toHaveBeenCalled()
    expect(res.body).toMatchObject({ committed: true })
  })

  it('not auto-approved -> approves with (patchId, gitRef), committed = merged', async () => {
    h.createLibraryPatch.mockResolvedValue({ ...PATCH, autoApproved: false })
    h.approveLibraryChange.mockResolvedValue({ merged: true, approvalCount: 1, requiredApprovals: 1 })
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(h.approveLibraryChange).toHaveBeenCalledWith('patch-1', 'deadbeef')
    expect(res.body).toMatchObject({ committed: true })
  })

  it('not auto-approved and approval not merged -> committed false', async () => {
    h.createLibraryPatch.mockResolvedValue({ ...PATCH, autoApproved: false })
    h.approveLibraryChange.mockResolvedValue({ merged: false, approvalCount: 1, requiredApprovals: 2 })
    const res = mockRes()
    await handler({ body: { sessionId: 's' } }, res)
    expect(res.body).toMatchObject({ committed: false })
  })
})
