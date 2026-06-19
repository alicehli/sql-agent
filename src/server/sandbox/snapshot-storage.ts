/**
 * Snapshot storage - tracks git commits associated with chat messages
 * This enables restoring sandbox state when navigating between worldlines
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { getProjectsRoot } from '../api/projects'

export interface StoredSnapshot {
  commitSha: string
  messageUuid: string
  sessionId: string
  sandboxId: string
  createdAt: number
  description?: string
}

const SNAPSHOTS_DIR = 'snapshots'

function getSnapshotsDir(projectId: string): string | null {
  const projectsRoot = getProjectsRoot()
  if (!projectsRoot) return null
  return path.join(projectsRoot, projectId, SNAPSHOTS_DIR)
}

/**
 * Save a snapshot reference
 */
export async function saveSnapshot(
  projectId: string,
  snapshot: StoredSnapshot
): Promise<void> {
  const snapshotsDir = getSnapshotsDir(projectId)
  if (!snapshotsDir) return

  // Ensure snapshots directory exists
  await mkdir(snapshotsDir, { recursive: true })

  // Use sessionId_messageUuid as filename for easy lookup
  const filename = `${snapshot.sessionId}_${snapshot.messageUuid}.json`
  const filePath = path.join(snapshotsDir, filename)

  await writeFile(filePath, JSON.stringify(snapshot, null, 2))
}

/**
 * Load a snapshot by session and message UUID
 */
export async function loadSnapshot(
  projectId: string,
  sessionId: string,
  messageUuid: string
): Promise<StoredSnapshot | null> {
  const snapshotsDir = getSnapshotsDir(projectId)
  if (!snapshotsDir) return null

  const filename = `${sessionId}_${messageUuid}.json`
  const filePath = path.join(snapshotsDir, filename)

  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as StoredSnapshot
  } catch {
    return null
  }
}

/**
 * Find the most recent snapshot for a session (before or at a given message)
 * This is useful when we need to restore state for a worldline
 */
export async function findLatestSnapshotForSession(
  projectId: string,
  sessionId: string
): Promise<StoredSnapshot | null> {
  const snapshotsDir = getSnapshotsDir(projectId)
  if (!snapshotsDir) return null

  try {
    const files = await readdir(snapshotsDir)

    const sessionSnapshots: StoredSnapshot[] = []

    for (const file of files) {
      if (!file.startsWith(`${sessionId}_`) || !file.endsWith('.json')) {
        continue
      }

      const filePath = path.join(snapshotsDir, file)
      try {
        const content = await readFile(filePath, 'utf8')
        const snapshot = JSON.parse(content) as StoredSnapshot
        sessionSnapshots.push(snapshot)
      } catch {
        continue
      }
    }

    if (sessionSnapshots.length === 0) {
      return null
    }

    // Sort by createdAt descending and return the most recent
    sessionSnapshots.sort((a, b) => b.createdAt - a.createdAt)
    return sessionSnapshots[0]
  } catch {
    return null
  }
}

/**
 * Load a snapshot by message UUID (searches across all sessions in the project)
 * This is useful for finding the parent session's snapshot at a branch point
 */
export async function loadSnapshotByMessageUuid(
  projectId: string,
  messageUuid: string
): Promise<StoredSnapshot | null> {
  const snapshotsDir = getSnapshotsDir(projectId)
  if (!snapshotsDir) return null

  try {
    const files = await readdir(snapshotsDir)

    for (const file of files) {
      if (!file.endsWith(`_${messageUuid}.json`)) {
        continue
      }

      const filePath = path.join(snapshotsDir, file)
      try {
        const content = await readFile(filePath, 'utf8')
        return JSON.parse(content) as StoredSnapshot
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get all snapshots for a session
 */
export async function getSessionSnapshots(
  projectId: string,
  sessionId: string
): Promise<StoredSnapshot[]> {
  const snapshotsDir = getSnapshotsDir(projectId)
  if (!snapshotsDir) return []

  try {
    const files = await readdir(snapshotsDir)

    const snapshots: StoredSnapshot[] = []

    for (const file of files) {
      if (!file.startsWith(`${sessionId}_`) || !file.endsWith('.json')) {
        continue
      }

      const filePath = path.join(snapshotsDir, file)
      try {
        const content = await readFile(filePath, 'utf8')
        const snapshot = JSON.parse(content) as StoredSnapshot
        snapshots.push(snapshot)
      } catch {
        continue
      }
    }

    // Sort by createdAt ascending (chronological order)
    snapshots.sort((a, b) => a.createdAt - b.createdAt)
    return snapshots
  } catch {
    return []
  }
}
