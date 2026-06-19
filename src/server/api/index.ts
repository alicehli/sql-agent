import type { Express } from 'express'
import express from 'express'
import { getAuth } from '@clerk/express'

import { collectProjects, getCurrentProjectId } from './projects'
import { collectSessionSummaries, readSessionDetails } from './project-sessions'
import { getWorldlineSiblings, saveBranchMetadata } from './branches'
import sandboxRouter from './sandbox'
import { sandboxManager } from '../sandbox/e2b-manager'
import {
  saveSnapshot,
  loadSnapshot,
  findLatestSnapshotForSession,
  getSessionSnapshots,
} from '../sandbox/snapshot-storage'
import {
  getUserSessions,
  getSession,
  getBranchInfo,
  getWorldlineFamily,
  createBranch,
  upsertSession,
  initAppDb,
  renameSession,
  deleteSession,
  createPlaybook,
  listPlaybooks,
  getPlaybook,
  updatePlaybook,
  deletePlaybook,
} from '../db/app-db'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/**
 * Resolve the authenticated user id, or send a 401 and return null.
 * Use at the top of any route that exposes or mutates user data.
 */
function requireUserId(req: express.Request, res: express.Response): string | null {
  const { userId } = getAuth(req)
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return userId
}

/**
 * Deny access when the session is tracked in the app DB and owned by a different
 * user. Returns true if access was denied (and a 403 was sent). Sessions that are
 * not in the DB (e.g. legacy file-only sessions) are allowed through to avoid
 * regressing existing access.
 */
async function denyIfNotSessionOwner(
  sessionId: string,
  userId: string,
  res: express.Response,
): Promise<boolean> {
  const session = await getSession(sessionId)
  if (session && session.userId !== userId) {
    res.status(403).json({ error: 'Access denied' })
    return true
  }
  return false
}

export async function registerApiRoutes(app: Express) {
  // Initialize app database and wait for it to be ready
  await initAppDb()

  // JSON body parser for POST requests
  app.use('/api', express.json())

  app.use('/api', (req, res, next) => {
    res.set(corsHeaders)

    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }

    next()
  })

  // Sandbox API routes
  app.use('/api', sandboxRouter)

  // Get current project config (for frontend to know the project ID)
  // projectId is cwd-based for SDK compatibility; userId is from Clerk auth
  app.get('/api/config', (req, res) => {
    const auth = getAuth(req)
    res.json({
      projectId: getCurrentProjectId(),
      userId: auth.userId || null,
    })
  })

  // ============ User-Scoped Session API (using app database) ============

  // Get all sessions for the authenticated user
  app.get('/api/sessions', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    try {
      const sessions = await getUserSessions(auth.userId)
      res.json({
        sessions: sessions.map(s => ({
          id: s.id,
          // Use title if set, otherwise generate from creation date
          prompt: s.title || `Chat from ${s.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          firstMessageAt: s.createdAt.getTime(),
          lastMessageAt: s.updatedAt.getTime(),
        }))
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to list sessions', details: formatErrorMessage(error) })
    }
  })

  // Get a specific session (with auth check)
  app.get('/api/sessions/:sessionId', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { sessionId } = req.params

    try {
      const session = await getSession(sessionId)

      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }

      // Check ownership
      if (session.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      res.json({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        messageCount: session.messageCount,
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to get session', details: formatErrorMessage(error) })
    }
  })

  // Rename a session (with auth check)
  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { sessionId } = req.params
    const { title } = req.body

    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Missing required field: title' })
      return
    }

    try {
      const session = await getSession(sessionId)

      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }

      // Check ownership
      if (session.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      await renameSession(sessionId, title)
      res.json({ success: true })
    } catch (error) {
      console.error('Rename session error:', error)
      res.status(500).json({ error: 'Failed to rename session', details: formatErrorMessage(error) })
    }
  })

  // Delete a session (with auth check)
  app.delete('/api/sessions/:sessionId', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { sessionId } = req.params

    try {
      const session = await getSession(sessionId)

      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }

      // Check ownership
      if (session.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      await deleteSession(sessionId)
      res.json({ success: true })
    } catch (error) {
      console.error('Delete session error:', error)
      res.status(500).json({ error: 'Failed to delete session', details: formatErrorMessage(error) })
    }
  })

  // Get worldlines for a session (with auth check)
  app.get('/api/sessions/:sessionId/worldlines', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { sessionId } = req.params

    try {
      // Get the session to check ownership
      const session = await getSession(sessionId)
      if (!session || session.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      // Get all sessions in this worldline family
      const familyIds = await getWorldlineFamily(sessionId)

      // Get details for each session
      const worldlines = await Promise.all(
        familyIds.map(async (id) => {
          const s = await getSession(id)
          const branchInfo = await getBranchInfo(id)
          return {
            sessionId: id,
            title: s?.title || `Session ${id.substring(0, 8)}`,
            branchPointMessageUuid: branchInfo?.branchAtMessageUuid || null,
            branchPointParentUuid: branchInfo?.branchPointParentUuid || null,
            parentSessionId: branchInfo?.parentSessionId || null,
            createdAt: s?.createdAt.toISOString(),
            updatedAt: s?.updatedAt.toISOString(),
          }
        })
      )

      res.json({ worldlines })
    } catch (error) {
      res.status(500).json({ error: 'Failed to get worldlines', details: formatErrorMessage(error) })
    }
  })

  // Create a branch (with auth check)
  app.post('/api/sessions/:sessionId/branches', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { sessionId: parentSessionId } = req.params
    const { newSessionId, branchAtMessageUuid, branchPointParentUuid } = req.body

    if (!newSessionId || !branchAtMessageUuid) {
      res.status(400).json({ error: 'Missing required fields: newSessionId, branchAtMessageUuid' })
      return
    }

    try {
      // Check ownership of parent session
      const parentSession = await getSession(parentSessionId)
      if (!parentSession || parentSession.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      // Create the new session record
      await upsertSession(newSessionId, auth.userId)

      // Create the branch record
      await createBranch(newSessionId, parentSessionId, branchAtMessageUuid, branchPointParentUuid)

      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ error: 'Failed to create branch', details: formatErrorMessage(error) })
    }
  })

  // ============ Playbook API ============

  // Get all playbooks for the authenticated user
  app.get('/api/playbooks', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    try {
      const playbooks = await listPlaybooks(auth.userId)
      res.json({
        playbooks: playbooks.map(p => ({
          id: p.id,
          name: p.name,
          prompt: p.prompt,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        }))
      })
    } catch (error) {
      res.status(500).json({ error: 'Failed to list playbooks', details: formatErrorMessage(error) })
    }
  })

  // Create a new playbook
  app.post('/api/playbooks', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { id, name, prompt } = req.body

    if (!id || !name || !prompt) {
      res.status(400).json({ error: 'Missing required fields: id, name, prompt' })
      return
    }

    try {
      await createPlaybook(id, auth.userId, name, prompt)
      res.json({ success: true, id })
    } catch (error) {
      res.status(500).json({ error: 'Failed to create playbook', details: formatErrorMessage(error) })
    }
  })

  // Update a playbook
  app.patch('/api/playbooks/:id', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { id } = req.params
    const { name, prompt } = req.body

    try {
      const playbook = await getPlaybook(id)

      if (!playbook) {
        res.status(404).json({ error: 'Playbook not found' })
        return
      }

      // Check ownership
      if (playbook.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      // Use existing values if not provided
      const newName = name || playbook.name
      const newPrompt = prompt || playbook.prompt

      await updatePlaybook(id, newName, newPrompt)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ error: 'Failed to update playbook', details: formatErrorMessage(error) })
    }
  })

  // Delete a playbook
  app.delete('/api/playbooks/:id', async (req, res) => {
    const auth = getAuth(req)
    if (!auth.userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const { id } = req.params

    try {
      const playbook = await getPlaybook(id)

      if (!playbook) {
        res.status(404).json({ error: 'Playbook not found' })
        return
      }

      // Check ownership
      if (playbook.userId !== auth.userId) {
        res.status(403).json({ error: 'Access denied' })
        return
      }

      await deletePlaybook(id)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete playbook', details: formatErrorMessage(error) })
    }
  })

  // ============ Legacy Project-based API (for backward compatibility) ============

  app.get('/api/projects', async (req, res) => {
    if (!requireUserId(req, res)) return
    try {
      const projects = await collectProjects()
      res.json({ projects })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to list projects', details: formatErrorMessage(error) })
    }
  })

  app.get('/api/projects/:projectId', async (req, res) => {
    if (!requireUserId(req, res)) return
    const { projectId } = req.params

    try {
      const sessions = await collectSessionSummaries(projectId)

      if (sessions === null) {
        res.status(404).json({ error: `Project '${projectId}' not found` })
        return
      }

      res.json({ sessions })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to list project sessions', details: formatErrorMessage(error) })
    }
  })

  app.get('/api/projects/:projectId/sessions/:sessionId', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId } = req.params
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return

    try {
      const session = await readSessionDetails(projectId, sessionId)

      if (session === null) {
        res
          .status(404)
          .json({ error: `Session '${sessionId}' not found` })
        return
      }

      res.json(session)
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to read session details', details: formatErrorMessage(error) })
    }
  })

  // Get worldline siblings for a session (all branches in the same family)
  app.get('/api/projects/:projectId/sessions/:sessionId/worldlines', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId } = req.params
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return

    try {
      const siblings = await getWorldlineSiblings(projectId, sessionId)
      res.json({ worldlines: siblings })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to get worldline siblings', details: formatErrorMessage(error) })
    }
  })

  // Save branch metadata (called after creating a branch)
  app.post('/api/projects/:projectId/branches', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId } = req.params
    const { sessionId, parentSessionId, branchPointMessageUuid } = req.body

    if (!sessionId || !parentSessionId || !branchPointMessageUuid) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    if (await denyIfNotSessionOwner(parentSessionId, userId, res)) return

    try {
      await saveBranchMetadata(projectId, {
        sessionId,
        parentSessionId,
        branchPointMessageUuid,
      })
      res.json({ success: true })
    } catch (error) {
      res
        .status(500)
        .json({ error: 'Failed to save branch metadata', details: formatErrorMessage(error) })
    }
  })

  // === Sandbox Snapshot API ===

  // Create a snapshot of the current sandbox state
  app.post('/api/projects/:projectId/sessions/:sessionId/snapshots', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId } = req.params
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return
    const { messageUuid, sandboxId, description } = req.body

    if (!messageUuid || !sandboxId) {
      res.status(400).json({ error: 'Missing required fields: messageUuid, sandboxId' })
      return
    }

    try {
      // Create git snapshot in sandbox
      const snapshot = await sandboxManager.createSnapshot(sandboxId, messageUuid, description)

      if (!snapshot) {
        res.status(500).json({ error: 'Failed to create snapshot in sandbox' })
        return
      }

      // Store snapshot reference
      await saveSnapshot(projectId, {
        commitSha: snapshot.commitSha,
        messageUuid,
        sessionId,
        sandboxId,
        createdAt: snapshot.createdAt,
        description: snapshot.message,
      })

      res.json({ success: true, snapshot })
    } catch (error) {
      res.status(500).json({ error: 'Failed to create snapshot', details: formatErrorMessage(error) })
    }
  })

  // Get all snapshots for a session
  app.get('/api/projects/:projectId/sessions/:sessionId/snapshots', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId } = req.params
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return

    try {
      const snapshots = await getSessionSnapshots(projectId, sessionId)
      res.json({ snapshots })
    } catch (error) {
      res.status(500).json({ error: 'Failed to get snapshots', details: formatErrorMessage(error) })
    }
  })

  // Restore sandbox to a specific snapshot (for worldline switching)
  app.post('/api/projects/:projectId/sessions/:sessionId/snapshots/restore', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId } = req.params
    const { sandboxId, targetSessionId } = req.body

    if (!sandboxId) {
      res.status(400).json({ error: 'Missing required field: sandboxId' })
      return
    }

    // Verify ownership of both the route session and the explicit restore target.
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return
    if (targetSessionId && (await denyIfNotSessionOwner(targetSessionId, userId, res))) return

    // If targetSessionId is provided, restore to that session's latest snapshot
    // Otherwise, restore to current session's latest snapshot
    const restoreSessionId = targetSessionId || sessionId

    try {
      // Find the latest snapshot for the target session
      const snapshot = await findLatestSnapshotForSession(projectId, restoreSessionId)

      if (!snapshot) {
        // No snapshot found - this is OK for new sessions, just return success
        res.json({ success: true, message: 'No snapshot found for session', restored: false })
        return
      }

      // Check if the snapshot is from the same sandbox
      // If not, we can't restore (each sandbox has its own git repo)
      if (snapshot.sandboxId !== sandboxId) {
        res.json({
          success: true,
          restored: false,
          message: 'Snapshot from different sandbox - sandbox state not restored',
          snapshot: {
            commitSha: snapshot.commitSha,
            messageUuid: snapshot.messageUuid,
            originalSandboxId: snapshot.sandboxId,
          },
        })
        return
      }

      // Restore the sandbox to that commit
      const success = await sandboxManager.restoreSnapshot(sandboxId, snapshot.commitSha)

      if (!success) {
        res.json({
          success: true,
          restored: false,
          message: 'Git restore failed - sandbox state not restored',
        })
        return
      }

      res.json({
        success: true,
        restored: true,
        snapshot: {
          commitSha: snapshot.commitSha,
          messageUuid: snapshot.messageUuid,
          createdAt: snapshot.createdAt,
        },
      })
    } catch (error) {
      res.json({
        success: true,
        restored: false,
        message: `Restore error: ${formatErrorMessage(error)}`,
      })
    }
  })

  // Get snapshot for a specific message
  app.get('/api/projects/:projectId/sessions/:sessionId/snapshots/:messageUuid', async (req, res) => {
    const userId = requireUserId(req, res)
    if (!userId) return
    const { projectId, sessionId, messageUuid } = req.params
    if (await denyIfNotSessionOwner(sessionId, userId, res)) return

    try {
      const snapshot = await loadSnapshot(projectId, sessionId, messageUuid)

      if (!snapshot) {
        res.status(404).json({ error: 'Snapshot not found' })
        return
      }

      res.json({ snapshot })
    } catch (error) {
      res.status(500).json({ error: 'Failed to load snapshot', details: formatErrorMessage(error) })
    }
  })
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  return 'Unknown error'
}
