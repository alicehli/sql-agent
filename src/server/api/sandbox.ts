import { Router, type Request, type Response } from 'express'
import { getAuth } from '@clerk/express'
import { sandboxManager } from '../sandbox/sandcastle-manager'
import { getSandboxOwnerUserId } from '../db/app-db'

const router = Router()

/**
 * Resolve the authenticated user id, or send 401 and return null.
 * These routes can read files from and execute code inside sandboxes, so they must
 * never be reachable unauthenticated.
 */
function requireUserId(req: Request, res: Response): string | null {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return userId
}

/**
 * Require auth AND that the sandbox belongs to the caller. A sandbox with no owning
 * session yet (just created, not persisted) is allowed for any authenticated user so
 * brand-new-session file browsing isn't broken; once persisted, cross-user access is
 * denied. Returns the userId on success, or null after sending 401/403.
 */
async function requireSandboxAccess(
  req: Request,
  res: Response,
  sandboxId: string,
): Promise<string | null> {
  const userId = requireUserId(req, res)
  if (!userId) return null

  let owner: string | null
  try {
    owner = await getSandboxOwnerUserId(sandboxId)
  } catch {
    res.status(403).json({ error: 'Access denied' })
    return null
  }

  if (owner !== null && owner !== userId) {
    res.status(403).json({ error: 'Access denied' })
    return null
  }
  return userId
}

// List TextQL connectors available to the caller (read-only)
router.get('/connectors', async (req, res) => {
  if (!requireUserId(req, res)) return

  try {
    const connectors = await sandboxManager.listConnectors()
    res.json(connectors)
  } catch {
    res.status(502).json({ error: 'Failed to load connectors' })
  }
})

// List the caller's own sandboxes
router.get('/sandboxes', async (req, res) => {
  const userId = requireUserId(req, res)
  if (!userId) return

  try {
    const sandboxes = sandboxManager.listSandboxes()
    const owned = await Promise.all(
      sandboxes.map(async (sandbox) =>
        (await getSandboxOwnerUserId(sandbox.id)) === userId ? sandbox : null,
      ),
    )
    res.json(owned.filter(Boolean))
  } catch {
    res.json([])
  }
})

// Create a new sandbox
router.post('/sandboxes', async (req, res) => {
  if (!requireUserId(req, res)) return
  try {
    const sandboxId = await sandboxManager.createSandbox()
    res.json({ id: sandboxId, status: 'running' })
  } catch {
    res.status(500).json({ error: 'Failed to create sandbox' })
  }
})

// List files in a sandbox
router.get('/sandboxes/:id/files', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return
  const path = (req.query.path as string) || '/sandbox/files'

  try {
    const files = await sandboxManager.listFiles(id, path)
    res.json(files)
  } catch {
    res.json([])
  }
})

// Get file content
router.get('/sandboxes/:id/files/content', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return
  const filePath = req.query.path as string

  if (!filePath) {
    res.status(400).json({ error: 'path query parameter required' })
    return
  }

  try {
    const { content, encoding } = await sandboxManager.readFile(id, filePath)
    res.json({ content, encoding })
  } catch {
    res.status(500).json({ error: 'Failed to read file' })
  }
})

// Get MIME type from file extension
function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() || ''
  const mimeTypes: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    // Documents
    pdf: 'application/pdf',
    // Archives
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    // Text
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    html: 'text/html',
    css: 'text/css',
    md: 'text/markdown',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

// Download file (returns raw content for saving)
router.get('/sandboxes/:id/download', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return
  const filePath = req.query.path as string

  if (!filePath) {
    res.status(400).json({ error: 'path query parameter required' })
    return
  }

  try {
    const fileName = filePath.split('/').pop() || 'download'
    const { content, encoding } = await sandboxManager.readFile(id, filePath)
    const mimeType = getMimeType(fileName)

    if (encoding === 'base64') {
      const buffer = Buffer.from(content, 'base64')
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', buffer.length)
      res.send(buffer)
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
      res.setHeader('Content-Type', mimeType)
      res.send(content)
    }
  } catch {
    res.status(500).json({ error: 'Failed to download file' })
  }
})

// Execute code in sandbox
router.post('/sandboxes/:id/execute', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return
  const { code, language = 'python' } = req.body

  if (!code) {
    res.status(400).json({ error: 'code field required' })
    return
  }

  try {
    const result = await sandboxManager.executeCode(id, code, language)
    res.json(result)
  } catch {
    res.status(500).json({ error: 'Failed to execute code' })
  }
})

// Execute command in sandbox
router.post('/sandboxes/:id/command', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return
  const { command } = req.body

  if (!command) {
    res.status(400).json({ error: 'command field required' })
    return
  }

  try {
    const result = await sandboxManager.executeCommand(id, command)
    res.json(result)
  } catch {
    res.status(500).json({ error: 'Failed to execute command' })
  }
})

// Pause sandbox (for state snapshots)
router.post('/sandboxes/:id/pause', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return

  try {
    const pausedId = await sandboxManager.pauseSandbox(id)
    res.json({ pausedId })
  } catch {
    res.status(500).json({ error: 'Failed to pause sandbox' })
  }
})

// Resume sandbox
router.post('/sandboxes/:id/resume', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return

  try {
    await sandboxManager.resumeSandbox(id)
    res.json({ status: 'running' })
  } catch {
    res.status(500).json({ error: 'Failed to resume sandbox' })
  }
})

// Kill sandbox
router.delete('/sandboxes/:id', async (req, res) => {
  const { id } = req.params
  if (!(await requireSandboxAccess(req, res, id))) return

  try {
    await sandboxManager.killSandbox(id)
    res.json({ status: 'killed' })
  } catch {
    res.status(500).json({ error: 'Failed to kill sandbox' })
  }
})

export default router
