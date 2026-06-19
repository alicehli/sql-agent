import { Sandbox } from '@e2b/code-interpreter'

// Binary file extensions that require base64 encoding for transfer
const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'ico', 'bmp', 'tiff', 'mp3', 'mp4', 'wav', 'avi', 'mov']

export interface SandboxInfo {
  id: string
  status: 'running' | 'paused' | 'expired' | 'unknown'
  createdAt: Date
  gitInitialized?: boolean
}

export interface GetOrCreateSandboxResult {
  sandboxId: string
  isNew: boolean
  wasRestored: boolean
}

export interface SandboxSnapshot {
  commitSha: string
  messageUuid: string
  sandboxId: string
  createdAt: number
  message: string
}

export interface FileInfo {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
}

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

/**
 * E2B Sandbox Manager
 * Handles creation, lifecycle, and operations on E2B sandboxes
 */
export class E2BSandboxManager {
  private sandboxes: Map<string, Sandbox> = new Map()
  private sandboxInfo: Map<string, SandboxInfo> = new Map()

  constructor() {
    // E2B uses E2B_API_KEY from environment automatically
  }

  /**
   * Create a new sandbox with git initialized
   * Uses E2B beta API with autoPause - sandbox pauses instead of being killed on timeout
   */
  async createSandbox(): Promise<string> {
    // Use betaCreate with autoPause for persistence
    const sandbox = await Sandbox.betaCreate({
      autoPause: true,
      timeoutMs: 10 * 60 * 1000, // 10 minutes idle timeout
    })

    const id = sandbox.sandboxId
    this.sandboxes.set(id, sandbox)
    this.sandboxInfo.set(id, {
      id,
      status: 'running',
      createdAt: new Date(),
      gitInitialized: false,
    })

    // Initialize git for versioning
    await this.initializeGit(id)

    return id
  }

  /**
   * Initialize git repository in sandbox for state versioning
   */
  private async initializeGit(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) return

    try {
      // Initialize git repo in /home/user
      await sandbox.commands.run('cd /home/user && git init')
      await sandbox.commands.run('cd /home/user && git config user.email "sandbox@e2b.dev"')
      await sandbox.commands.run('cd /home/user && git config user.name "Sandbox"')

      // Create .gitignore for common excludes
      await sandbox.files.write('/home/user/.gitignore', `
__pycache__/
*.pyc
.ipynb_checkpoints/
node_modules/
.venv/
venv/
*.log
`)

      // Initial commit
      await sandbox.commands.run('cd /home/user && git add -A && git commit -m "Initial sandbox state" --allow-empty')

      const info = this.sandboxInfo.get(sandboxId)
      if (info) {
        info.gitInitialized = true
      }
    } catch {
      // Git initialization is best-effort
    }
  }

  /**
   * Get or reconnect to a sandbox
   */
  async getSandbox(sandboxId: string): Promise<Sandbox | null> {
    // Check if we have an active connection
    let sandbox = this.sandboxes.get(sandboxId)

    if (sandbox) {
      return sandbox
    }

    // Try to reconnect to existing sandbox
    try {
      sandbox = await Sandbox.connect(sandboxId)
      this.sandboxes.set(sandboxId, sandbox)
      this.sandboxInfo.set(sandboxId, {
        id: sandboxId,
        status: 'running',
        createdAt: new Date(),
      })
      return sandbox
    } catch {
      return null
    }
  }

  /**
   * List all active sandboxes
   */
  listSandboxes(): SandboxInfo[] {
    return Array.from(this.sandboxInfo.values())
  }

  /**
   * List files in a sandbox directory
   */
  async listFiles(sandboxId: string, dirPath: string = '/home/user'): Promise<FileInfo[]> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    try {
      const entries = await sandbox.files.list(dirPath)
      return entries.map((entry) => ({
        name: entry.name,
        path: dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`,
        type: entry.type === 'dir' ? 'directory' : 'file',
        size: 0, // E2B doesn't provide size in list
      }))
    } catch {
      return []
    }
  }

  /**
   * Read file content from sandbox
   */
  async readFile(sandboxId: string, filePath: string): Promise<{ content: string; encoding: 'text' | 'base64' }> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    const ext = filePath.toLowerCase().split('.').pop() || ''
    const isBinary = BINARY_EXTENSIONS.includes(ext)

    try {
      if (isBinary) {
        // Use base64 command to read binary files reliably
        // This avoids encoding issues with sandbox.files.read() on binary data
        const result = await sandbox.commands.run(`base64 "${filePath}"`)
        if (result.exitCode !== 0) {
          throw new Error(`Failed to read binary file: ${result.stderr}`)
        }
        // Remove any newlines that base64 command adds
        const base64 = result.stdout.replace(/\n/g, '')
        return { content: base64, encoding: 'base64' }
      } else {
        const content = await sandbox.files.read(filePath)
        // If it's a Uint8Array, convert to string
        const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
        return { content: text, encoding: 'text' }
      }
    } catch (error) {
      throw error
    }
  }

  /**
   * Write file to sandbox
   */
  async writeFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    await sandbox.files.write(filePath, content)
  }

  /**
   * Execute code in sandbox
   */
  async executeCode(sandboxId: string, code: string, language: 'python' | 'javascript' = 'python'): Promise<ExecutionResult> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    try {
      const execution = await sandbox.runCode(code, { language })

      return {
        stdout: execution.logs.stdout.join('\n'),
        stderr: execution.logs.stderr.join('\n'),
        exitCode: execution.error ? 1 : 0,
        error: execution.error ? String(execution.error) : undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
  }

  /**
   * Execute shell command in sandbox
   */
  async executeCommand(sandboxId: string, command: string): Promise<ExecutionResult> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    try {
      const result = await sandbox.commands.run(command)
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
  }

  /**
   * Create a git snapshot of the current sandbox state
   * Returns the commit SHA that can be used to restore this state
   */
  async createSnapshot(sandboxId: string, messageUuid: string, commitMessage?: string): Promise<SandboxSnapshot | null> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      return null
    }

    try {
      const message = commitMessage || `Snapshot at message ${messageUuid}`

      // Stage all changes and commit
      await sandbox.commands.run('cd /home/user && git add -A')

      // Check if there are changes to commit
      const statusResult = await sandbox.commands.run('cd /home/user && git status --porcelain')
      if (statusResult.stdout.trim() === '') {
        // No changes, get current HEAD
        const headResult = await sandbox.commands.run('cd /home/user && git rev-parse HEAD')
        const commitSha = headResult.stdout.trim()
        return {
          commitSha,
          messageUuid,
          sandboxId,
          createdAt: Date.now(),
          message: 'No changes (using existing HEAD)',
        }
      }

      // Commit changes
      await sandbox.commands.run(`cd /home/user && git commit -m "${message.replace(/"/g, '\\"')}"`)

      // Get the commit SHA
      const result = await sandbox.commands.run('cd /home/user && git rev-parse HEAD')
      const commitSha = result.stdout.trim()

      return {
        commitSha,
        messageUuid,
        sandboxId,
        createdAt: Date.now(),
        message,
      }
    } catch {
      return null
    }
  }

  /**
   * Restore sandbox state to a specific git commit
   */
  async restoreSnapshot(sandboxId: string, commitSha: string): Promise<boolean> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) {
      return false
    }

    try {
      // Stash any uncommitted changes first
      await sandbox.commands.run('cd /home/user && git stash --include-untracked || true')

      // Checkout the target commit
      const result = await sandbox.commands.run(`cd /home/user && git checkout ${commitSha} --force`)

      return result.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * Get the current git commit SHA
   */
  async getCurrentCommit(sandboxId: string): Promise<string | null> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) return null

    try {
      const result = await sandbox.commands.run('cd /home/user && git rev-parse HEAD')
      return result.stdout.trim()
    } catch {
      return null
    }
  }

  /**
   * Get git log (list of snapshots)
   */
  async getSnapshotHistory(sandboxId: string, limit: number = 20): Promise<Array<{ sha: string; message: string; date: string }>> {
    const sandbox = await this.getSandbox(sandboxId)
    if (!sandbox) return []

    try {
      const result = await sandbox.commands.run(
        `cd /home/user && git log --pretty=format:"%H|%s|%ci" -n ${limit}`
      )

      if (!result.stdout.trim()) return []

      return result.stdout.trim().split('\n').map(line => {
        const [sha, message, date] = line.split('|')
        return { sha: sha || '', message: message || '', date: date || '' }
      })
    } catch {
      return []
    }
  }

  /**
   * Pause sandbox using beta API
   * This properly pauses the sandbox so it can be resumed later
   */
  async pauseSandbox(sandboxId: string): Promise<string> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (!sandbox) {
      // Already disconnected, just return the ID
      return sandboxId
    }

    try {
      // Use beta pause API if available
      const sbx = sandbox as unknown as { betaPause?: () => Promise<void> }
      if (typeof sbx.betaPause === 'function') {
        await sbx.betaPause()
      }

      const info = this.sandboxInfo.get(sandboxId)
      if (info) {
        info.status = 'paused'
      }

      // Remove from active connections but keep info
      this.sandboxes.delete(sandboxId)
      return sandboxId
    } catch (error) {
      // On error, still disconnect and mark as paused
      this.sandboxes.delete(sandboxId)
      const info = this.sandboxInfo.get(sandboxId)
      if (info) {
        info.status = 'paused'
      }
      return sandboxId
    }
  }

  /**
   * Resume/reconnect to a paused sandbox
   */
  async resumeSandbox(sandboxId: string): Promise<Sandbox> {
    const sandbox = await Sandbox.connect(sandboxId)
    this.sandboxes.set(sandboxId, sandbox)
    this.sandboxInfo.set(sandboxId, {
      id: sandboxId,
      status: 'running',
      createdAt: new Date(),
    })
    return sandbox
  }

  /**
   * Resume sandbox with validation against expected git commit
   * Used to detect E2B bug #884 where pause/resume cycles lose file changes
   * Returns whether the commit matches (true = valid, false = needs restore)
   */
  async resumeSandboxWithValidation(
    sandboxId: string,
    expectedCommitSha?: string
  ): Promise<{ sandbox: Sandbox; isValid: boolean; currentCommit: string | null }> {
    const sandbox = await this.resumeSandbox(sandboxId)

    if (!expectedCommitSha) {
      return { sandbox, isValid: true, currentCommit: null }
    }

    // Verify git commit matches expected
    const currentCommit = await this.getCurrentCommit(sandboxId)

    if (!currentCommit) {
      // Git not initialized or error - consider valid (can't verify)
      return { sandbox, isValid: true, currentCommit: null }
    }

    const isValid = currentCommit === expectedCommitSha
    return { sandbox, isValid, currentCommit }
  }

  /**
   * Get or create a sandbox with graceful degradation
   * - Tries to resume existing sandbox if provided
   * - Validates git state if snapshotCommitSha provided
   * - Falls back to creating new sandbox on failure
   */
  async getOrCreateSandbox(
    existingSandboxId?: string,
    snapshotCommitSha?: string
  ): Promise<GetOrCreateSandboxResult> {
    // Try to resume existing sandbox
    if (existingSandboxId) {
      try {
        const { isValid, currentCommit } = await this.resumeSandboxWithValidation(
          existingSandboxId,
          snapshotCommitSha
        )

        if (isValid) {
          return { sandboxId: existingSandboxId, isNew: false, wasRestored: false }
        }

        // Git state mismatch (E2B bug #884) - restore from snapshot
        if (snapshotCommitSha && currentCommit !== snapshotCommitSha) {
          const restored = await this.restoreSnapshot(existingSandboxId, snapshotCommitSha)
          if (restored) {
            return { sandboxId: existingSandboxId, isNew: false, wasRestored: true }
          }
        }

        // Restore failed but sandbox is connected - use it anyway
        return { sandboxId: existingSandboxId, isNew: false, wasRestored: false }
      } catch (error) {
        // Resume failed - sandbox may be expired or deleted
        // Clean up local state
        this.sandboxes.delete(existingSandboxId)
        this.sandboxInfo.delete(existingSandboxId)
      }
    }

    // Create new sandbox
    const newSandboxId = await this.createSandbox()
    return { sandboxId: newSandboxId, isNew: true, wasRestored: false }
  }

  /**
   * Kill a sandbox
   */
  async killSandbox(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId)
    if (sandbox) {
      await sandbox.kill()
      this.sandboxes.delete(sandboxId)
      this.sandboxInfo.delete(sandboxId)
    }
  }

  /**
   * Cleanup all sandboxes
   */
  async cleanup(): Promise<void> {
    for (const [, sandbox] of this.sandboxes) {
      try {
        await sandbox.kill()
      } catch {
        // Best effort cleanup
      }
    }
    this.sandboxes.clear()
    this.sandboxInfo.clear()
  }
}

// Singleton instance
export const sandboxManager = new E2BSandboxManager()
