/**
 * App Database - DuckDB for session management and user data
 *
 * IMPORTANT: This is completely separate from the SQL tools database (tpch.duckdb).
 * This database stores app internals: sessions, branches, user mappings.
 * Users cannot query this database through the SQL tool.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { getDuckDBPath } from '../lib/duckdb'

const execFileAsync = promisify(execFile)

// App database path - separate from TPC-H data
const APP_DB_PATH = path.join(os.homedir(), '.claude', 'app.duckdb')

/**
 * Validate that a value is safe to interpolate into SQL
 * UUIDs/nanoids are alphanumeric with dashes, so we allow [a-zA-Z0-9_-]
 */
function validateIdentifier(value: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${name}: contains disallowed characters`)
  }
  if (value.length > 100) {
    throw new Error(`Invalid ${name}: too long`)
  }
  return value
}

let dbInitialized = false
let dbInitializing = false
let duckdbPath: string | null = null

// Promise-chain mutex for serializing DB access
// Prevents concurrent CLI invocations which cause constraint errors
let dbLock: Promise<void> = Promise.resolve()

/**
 * Initialize the app database with required tables
 * Includes retry logic for lock contention
 */
export async function initAppDb(): Promise<void> {
  if (dbInitialized) return

  // Prevent concurrent initialization attempts
  if (dbInitializing) {
    // Wait for ongoing initialization
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      if (dbInitialized) return
    }
    throw new Error('Database initialization timeout')
  }

  dbInitializing = true

  try {
    duckdbPath = getDuckDBPath()

    // Create directory if needed
    const dbDir = path.dirname(APP_DB_PATH)
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    // Create tables if they don't exist
    const initSql = `
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY,
        user_id VARCHAR NOT NULL,
        title VARCHAR,
        sandbox_id VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS branches (
        session_id VARCHAR PRIMARY KEY,
        parent_session_id VARCHAR NOT NULL,
        branch_at_message_uuid VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      -- Note: idx_sessions_updated_at removed - causes DuckDB bug with UPDATE statements
      CREATE INDEX IF NOT EXISTS idx_branches_parent ON branches(parent_session_id);

      CREATE TABLE IF NOT EXISTS playbooks (
        id VARCHAR PRIMARY KEY,
        user_id VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        prompt TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_playbooks_user_id ON playbooks(user_id);
    `

    // Migration: add sandbox_id column if it doesn't exist
    const migrationSql = `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_id VARCHAR;
    `

    // Migration: add branch_point_parent_uuid column to branches table
    const branchMigrationSql = `
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS branch_point_parent_uuid VARCHAR;
    `

    // Migration: add sandbox_status column to sessions table
    const sandboxStatusMigrationSql = `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sandbox_status VARCHAR;
    `

    // Migration: add user_id column to playbooks table
    const playbookUserMigrationSql = `
      ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS user_id VARCHAR;
    `

    // Retry up to 3 times for lock contention
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runQuery(initSql)
        // Run migrations for existing databases
        try {
          await runQuery(migrationSql)
        } catch {
          // Column might already exist, ignore error
        }
        try {
          await runQuery(branchMigrationSql)
        } catch {
          // Column might already exist, ignore error
        }
        try {
          await runQuery(sandboxStatusMigrationSql)
        } catch {
          // Column might already exist, ignore error
        }
        try {
          await runQuery(playbookUserMigrationSql)
        } catch {
          // Column might already exist, ignore error
        }
        dbInitialized = true
        return
      } catch (error) {
        lastError = error as Error
        if (String(error).includes('lock')) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
        } else {
          throw error
        }
      }
    }
    throw lastError
  } finally {
    dbInitializing = false
  }
}

/**
 * Run a query against the app database
 * Uses a promise-chain mutex to serialize all queries and prevent concurrent CLI access
 */
async function runQuery(sql: string): Promise<Record<string, unknown>[]> {
  if (!duckdbPath) {
    duckdbPath = getDuckDBPath()
  }
  const dbBin = duckdbPath

  // Serialize all queries to prevent concurrent CLI access
  // This prevents DuckDB constraint errors from race conditions
  const previousLock = dbLock
  let releaseLock: () => void
  dbLock = new Promise(resolve => {
    releaseLock = resolve
  })

  await previousLock // Wait for previous query to complete

  try {
    const fullSql = sql.replace(/;?\s*$/, ';')

    // Use execFile (no shell) so the SQL — including session titles derived from
    // user message text — is passed as a single argv element and is never parsed by
    // a shell. This removes shell command-injection/RCE risk (backticks, $(), quotes)
    // and makes the previous manual quote/newline escaping unnecessary.
    const { stdout } = await execFileAsync(
      dbBin,
      [APP_DB_PATH, '-json', '-c', fullSql],
      { maxBuffer: 10 * 1024 * 1024 }
    )

    const trimmed = stdout.trim()
    if (!trimmed || trimmed === '[]') {
      return []
    }

    return JSON.parse(trimmed) as Record<string, unknown>[]
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error)
    throw new Error(`AppDB Error: ${errMsg}`)
  } finally {
    releaseLock!()
  }
}

// ============ Session Operations ============

export type SandboxStatus = 'running' | 'paused' | 'expired' | 'unknown'

export interface SessionRecord {
  id: string
  userId: string
  title: string | null
  sandboxId: string | null
  sandboxStatus: SandboxStatus | null
  createdAt: Date
  updatedAt: Date
  messageCount: number
}

/**
 * Create or update a session record
 */
export async function upsertSession(
  sessionId: string,
  userId: string,
  title?: string
): Promise<void> {
  await initAppDb()

  // Validate identifiers to prevent SQL injection
  validateIdentifier(sessionId, 'sessionId')
  validateIdentifier(userId, 'userId')

  const titleValue = title ? `'${title.replace(/'/g, "''")}'` : 'NULL'
  const now = new Date().toISOString()

  // First try to insert, if conflict then update
  // IMPORTANT: Include sandbox_id and sandbox_status to preserve them when replacing!
  // Note: Preserve updated_at for existing sessions - only update on actual user activity
  const insertSql = `
    INSERT OR REPLACE INTO sessions (id, user_id, title, sandbox_id, sandbox_status, created_at, updated_at, message_count)
    VALUES (
      '${sessionId}',
      '${userId}',
      COALESCE(${titleValue}, (SELECT title FROM sessions WHERE id = '${sessionId}')),
      (SELECT sandbox_id FROM sessions WHERE id = '${sessionId}'),
      (SELECT sandbox_status FROM sessions WHERE id = '${sessionId}'),
      COALESCE((SELECT created_at FROM sessions WHERE id = '${sessionId}'), '${now}'),
      COALESCE((SELECT updated_at FROM sessions WHERE id = '${sessionId}'), '${now}'),
      COALESCE((SELECT message_count FROM sessions WHERE id = '${sessionId}'), 0)
    )
  `

  await runQuery(insertSql)
}

/**
 * Update session message count and timestamp
 */
export async function updateSessionActivity(
  sessionId: string,
  messageCount?: number
): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')

  const countUpdate = messageCount !== undefined ? `, message_count = ${messageCount}` : ''
  const sql = `
    UPDATE sessions
    SET updated_at = CURRENT_TIMESTAMP ${countUpdate}
    WHERE id = '${sessionId}'
  `

  await runQuery(sql)
}

/**
 * Get all sessions for a user, ordered by most recent
 * Excludes branch sessions - those are only accessible via worldline navigator
 */
export async function getUserSessions(userId: string): Promise<SessionRecord[]> {
  await initAppDb()

  validateIdentifier(userId, 'userId')

  // LEFT JOIN with branches table and exclude any session that exists as a branch
  // This ensures only root sessions appear in the sidebar
  const sql = `
    SELECT s.id, s.user_id, s.title, s.sandbox_id, s.sandbox_status, s.created_at, s.updated_at, s.message_count
    FROM sessions s
    LEFT JOIN branches b ON s.id = b.session_id
    WHERE s.user_id = '${userId}'
      AND b.session_id IS NULL
    ORDER BY s.updated_at DESC
  `

  const rows = await runQuery(sql)

  return rows.map(row => ({
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string | null,
    sandboxId: row.sandbox_id as string | null,
    sandboxStatus: (row.sandbox_status as SandboxStatus | null) || null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    messageCount: row.message_count as number,
  }))
}

/**
 * Get a single session by ID
 */
export async function getSession(sessionId: string): Promise<SessionRecord | null> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')

  const sql = `
    SELECT id, user_id, title, sandbox_id, sandbox_status, created_at, updated_at, message_count
    FROM sessions
    WHERE id = '${sessionId}'
  `

  const rows = await runQuery(sql)

  if (rows.length === 0) return null

  const row = rows[0]!
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string | null,
    sandboxId: row.sandbox_id as string | null,
    sandboxStatus: (row.sandbox_status as SandboxStatus | null) || null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    messageCount: row.message_count as number,
  }
}

/**
 * Update the sandbox ID for a session
 */
export async function setSessionSandbox(sessionId: string, sandboxId: string): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')
  if (sandboxId) validateIdentifier(sandboxId, 'sandboxId')

  // Note: Don't update updated_at here - that should only change on actual user activity
  const updateSql = `
    UPDATE sessions
    SET sandbox_id = '${sandboxId}'
    WHERE id = '${sessionId}'
  `

  await runQuery(updateSql)
}

/**
 * Update the sandbox ID and status for a session
 */
export async function setSessionSandboxStatus(
  sessionId: string,
  sandboxId: string,
  status: SandboxStatus
): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')
  validateIdentifier(sandboxId, 'sandboxId')

  // Use simple UPDATE - session should already exist from upsertSession call
  // Note: Don't update updated_at here - that should only change on actual user activity
  const updateSql = `
    UPDATE sessions
    SET sandbox_id = '${sandboxId}', sandbox_status = '${status}'
    WHERE id = '${sessionId}'
  `

  try {
    await runQuery(updateSql)
  } catch (err) {
    // If update fails, the session might not exist yet - this is OK, it will be created later
    console.warn(`[AppDB] Failed to update sandbox status for session ${sessionId}:`, err)
  }
}

/**
 * Check if a session belongs to a user
 */
export async function sessionBelongsToUser(
  sessionId: string,
  userId: string
): Promise<boolean> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')
  validateIdentifier(userId, 'userId')

  const sql = `
    SELECT 1 FROM sessions
    WHERE id = '${sessionId}' AND user_id = '${userId}'
  `

  const rows = await runQuery(sql)
  return rows.length > 0
}

// ============ Branch Operations ============

export interface BranchRecord {
  sessionId: string
  parentSessionId: string
  branchAtMessageUuid: string
  branchPointParentUuid: string | null
  createdAt: Date
}

/**
 * Create a branch record
 */
export async function createBranch(
  sessionId: string,
  parentSessionId: string,
  branchAtMessageUuid: string,
  branchPointParentUuid?: string
): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')
  validateIdentifier(parentSessionId, 'parentSessionId')
  validateIdentifier(branchAtMessageUuid, 'branchAtMessageUuid')
  if (branchPointParentUuid) validateIdentifier(branchPointParentUuid, 'branchPointParentUuid')

  const sql = `
    INSERT INTO branches (session_id, parent_session_id, branch_at_message_uuid, branch_point_parent_uuid)
    VALUES ('${sessionId}', '${parentSessionId}', '${branchAtMessageUuid}', ${branchPointParentUuid ? `'${branchPointParentUuid}'` : 'NULL'})
    ON CONFLICT (session_id) DO NOTHING
  `

  await runQuery(sql)
}

/**
 * Get all branches for a parent session
 */
export async function getSessionBranches(parentSessionId: string): Promise<BranchRecord[]> {
  await initAppDb()

  validateIdentifier(parentSessionId, 'parentSessionId')

  const sql = `
    SELECT session_id, parent_session_id, branch_at_message_uuid, branch_point_parent_uuid, created_at
    FROM branches
    WHERE parent_session_id = '${parentSessionId}'
    ORDER BY created_at DESC
  `

  const rows = await runQuery(sql)

  return rows.map(row => ({
    sessionId: row.session_id as string,
    parentSessionId: row.parent_session_id as string,
    branchAtMessageUuid: row.branch_at_message_uuid as string,
    branchPointParentUuid: (row.branch_point_parent_uuid as string | null) || null,
    createdAt: new Date(row.created_at as string),
  }))
}

/**
 * Get branch info for a session (if it's a branch)
 */
export async function getBranchInfo(sessionId: string): Promise<BranchRecord | null> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')

  const sql = `
    SELECT session_id, parent_session_id, branch_at_message_uuid, branch_point_parent_uuid, created_at
    FROM branches
    WHERE session_id = '${sessionId}'
  `

  const rows = await runQuery(sql)

  if (rows.length === 0) return null

  const row = rows[0]!
  return {
    sessionId: row.session_id as string,
    parentSessionId: row.parent_session_id as string,
    branchAtMessageUuid: row.branch_at_message_uuid as string,
    branchPointParentUuid: (row.branch_point_parent_uuid as string | null) || null,
    createdAt: new Date(row.created_at as string),
  }
}

/**
 * Get all sessions in a worldline family (root + all branches recursively)
 */
export async function getWorldlineFamily(sessionId: string): Promise<string[]> {
  await initAppDb()

  // First, find the root session by traversing up.
  // Guard against cycles (e.g. corrupt data): a self-referential parent chain would
  // otherwise loop forever while holding the serialized DB lock and hang the server.
  let rootId = sessionId
  const seenAncestors = new Set<string>([rootId])
  let branchInfo = await getBranchInfo(rootId)
  while (branchInfo) {
    const parentId = branchInfo.parentSessionId
    if (seenAncestors.has(parentId)) break
    seenAncestors.add(parentId)
    rootId = parentId
    branchInfo = await getBranchInfo(rootId)
  }

  // Now get all descendants, skipping any already-visited session so a cycle can't
  // cause an infinite loop or an unbounded result.
  const visited = new Set<string>([rootId])
  const family = [rootId]
  const toProcess = [rootId]

  while (toProcess.length > 0) {
    const current = toProcess.pop()!
    const branches = await getSessionBranches(current)
    for (const branch of branches) {
      if (visited.has(branch.sessionId)) continue
      visited.add(branch.sessionId)
      family.push(branch.sessionId)
      toProcess.push(branch.sessionId)
    }
  }

  return family
}

/**
 * Rename a session
 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')

  // First get the existing session data
  const session = await getSession(sessionId)
  if (!session) {
    throw new Error('Session not found')
  }

  const escapedTitle = title.replace(/'/g, "''")
  const now = new Date().toISOString()

  // Use INSERT OR REPLACE with literal values (same pattern as upsertSession)
  const sql = `
    INSERT OR REPLACE INTO sessions (id, user_id, title, sandbox_id, sandbox_status, created_at, updated_at, message_count)
    VALUES (
      '${sessionId}',
      '${session.userId}',
      '${escapedTitle}',
      ${session.sandboxId ? `'${session.sandboxId}'` : 'NULL'},
      ${session.sandboxStatus ? `'${session.sandboxStatus}'` : 'NULL'},
      '${session.createdAt.toISOString()}',
      '${now}',
      ${session.messageCount}
    )
  `

  await runQuery(sql)
}

// ============ Playbook Operations ============

export interface PlaybookRecord {
  id: string
  userId: string
  name: string
  prompt: string
  createdAt: Date
  updatedAt: Date
}

/**
 * Create a new playbook
 */
export async function createPlaybook(
  id: string,
  userId: string,
  name: string,
  prompt: string
): Promise<void> {
  await initAppDb()

  validateIdentifier(id, 'id')
  validateIdentifier(userId, 'userId')

  const escapedName = name.replace(/'/g, "''")
  const escapedPrompt = prompt.replace(/'/g, "''")
  const now = new Date().toISOString()

  const sql = `
    INSERT INTO playbooks (id, user_id, name, prompt, created_at, updated_at)
    VALUES ('${id}', '${userId}', '${escapedName}', '${escapedPrompt}', '${now}', '${now}')
  `

  await runQuery(sql)
}

/**
 * List all playbooks for a user
 */
export async function listPlaybooks(userId: string): Promise<PlaybookRecord[]> {
  await initAppDb()

  validateIdentifier(userId, 'userId')

  const sql = `
    SELECT id, user_id, name, prompt, created_at, updated_at
    FROM playbooks
    WHERE user_id = '${userId}'
    ORDER BY updated_at DESC
  `

  const rows = await runQuery(sql)

  return rows.map(row => ({
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }))
}

/**
 * Get a playbook by ID
 */
export async function getPlaybook(id: string): Promise<PlaybookRecord | null> {
  await initAppDb()

  validateIdentifier(id, 'id')

  const sql = `
    SELECT id, user_id, name, prompt, created_at, updated_at
    FROM playbooks
    WHERE id = '${id}'
  `

  const rows = await runQuery(sql)

  if (rows.length === 0) return null

  const row = rows[0]!
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    prompt: row.prompt as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }
}

/**
 * Update a playbook (returns the playbook for ownership check)
 */
export async function updatePlaybook(
  id: string,
  name: string,
  prompt: string
): Promise<PlaybookRecord | null> {
  await initAppDb()

  validateIdentifier(id, 'id')

  const playbook = await getPlaybook(id)
  if (!playbook) {
    return null
  }

  const escapedName = name.replace(/'/g, "''")
  const escapedPrompt = prompt.replace(/'/g, "''")
  const now = new Date().toISOString()

  const sql = `
    INSERT OR REPLACE INTO playbooks (id, user_id, name, prompt, created_at, updated_at)
    VALUES (
      '${id}',
      '${playbook.userId}',
      '${escapedName}',
      '${escapedPrompt}',
      '${playbook.createdAt.toISOString()}',
      '${now}'
    )
  `

  await runQuery(sql)
  return playbook
}

/**
 * Delete a playbook
 */
export async function deletePlaybook(id: string): Promise<void> {
  await initAppDb()

  validateIdentifier(id, 'id')

  const sql = `
    DELETE FROM playbooks
    WHERE id = '${id}'
  `

  await runQuery(sql)
}

/**
 * Delete a session and all its branches (cascade delete entire worldline family)
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await initAppDb()

  validateIdentifier(sessionId, 'sessionId')

  // Get all sessions in this worldline family (root + all descendants)
  const familyIds = await getWorldlineFamily(sessionId)

  // Delete all branch records for these sessions
  for (const id of familyIds) {
    const deleteBranchesSql = `
      DELETE FROM branches
      WHERE session_id = '${id}' OR parent_session_id = '${id}'
    `
    await runQuery(deleteBranchesSql)
  }

  // Delete all session records in the family
  for (const id of familyIds) {
    const deleteSessionSql = `
      DELETE FROM sessions
      WHERE id = '${id}'
    `
    await runQuery(deleteSessionSql)
  }
}
