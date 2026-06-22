/**
 * TextQL Sandcastle Manager
 *
 * Drop-in replacement for E2BSandboxManager backed by the TextQL Sandcastle v2
 * REST API (https://docs.textql.com/api-reference/v2). Keeps the same public
 * method surface as E2BSandboxManager so callers only change their import path.
 *
 * Capability notes (vs E2B):
 *  - The Sandcastle API exposes Python execution (/execute), connector queries
 *    (/query), file upload (/files), status, list and delete. It has NO shell
 *    exec and NO file read/list endpoints, so executeCommand/readFile/listFiles/
 *    writeFile are shimmed through Python run in /execute (subprocess + base64).
 *  - There is NO pause/resume and NO snapshot/restore. The "worldlines" git
 *    snapshot feature is dropped: those methods are retained as inert no-ops so
 *    existing callers keep compiling, but they perform no work.
 */

// Binary file extensions that should be returned base64-encoded.
const BINARY_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'tar', 'gz', 'ico', 'bmp', 'tiff', 'mp3', 'mp4', 'wav', 'avi', 'mov']

// The execute() working directory inside a sandcastle.
export const SANDBOX_WORKDIR = '/sandbox/files'

// Sentinel used to fish a shim's payload out of the print-captured output array.
const RESULT_MARKER = '__SBX_RESULT__'

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

export interface ConnectorInfo {
  id: number
  name: string
  type: string
}

export interface QueryResult {
  dataframeName: string
  numRows: number
  numCols: number
  preview: string
}

export interface LibraryDiff {
  hasChanges: boolean
  diffs: Array<{ name: string; additions?: number; deletions?: number; is_new?: boolean; is_delete?: boolean; is_rename?: boolean }>
  rawDiff: string
}

export interface LibraryPatch {
  patchId: string
  patchNumber: number
  status: string
  gitRef: string
  hasConflicts: boolean
  conflicts?: string
  autoApproved: boolean
  rawDiff: string
}

interface ExecuteApiResponse {
  output: string[] | null
  error?: string
  execution_time_ms?: number
  files?: Array<{ name: string; url: string; mime_type: string }>
  dataframes?: unknown[]
}

interface SandcastleStatus {
  status?: string
  memory_usage?: string
  dataframes?: unknown[]
}

export class SandcastleManager {
  private sandboxInfo: Map<string, SandboxInfo> = new Map()

  private get baseUrl(): string {
    return (process.env.SANDBOX_BASE_URL || 'https://app.textql.com').replace(/\/+$/, '')
  }

  private get apiKey(): string {
    const key = process.env.SANDBOX_API_KEY
    if (!key) throw new Error('SANDBOX_API_KEY is not set')
    return key
  }

  /** Authenticated request to the Sandcastle API. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Sandcastle ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  /**
   * Create a new sandcastle.
   * (No git init — worldlines are dropped.)
   */
  async createSandbox(): Promise<string> {
    const { sandbox_id } = await this.request<{ sandbox_id: string; created_at: string }>(
      'POST',
      '/v2/sandcastles',
      {}
    )
    this.sandboxInfo.set(sandbox_id, {
      id: sandbox_id,
      status: 'running',
      createdAt: new Date(),
    })
    return sandbox_id
  }

  /**
   * Whether a sandcastle is currently reachable/running.
   * Replaces E2B's connection-based getSandbox(); returns the id or null.
   */
  async getSandbox(sandboxId: string): Promise<string | null> {
    try {
      const status = await this.request<SandcastleStatus>('GET', `/v2/sandcastles/${sandboxId}`)
      const running = status.status === 'running'
      if (running && !this.sandboxInfo.has(sandboxId)) {
        this.sandboxInfo.set(sandboxId, { id: sandboxId, status: 'running', createdAt: new Date() })
      }
      return running ? sandboxId : null
    } catch {
      return null
    }
  }

  /** List sandboxes this process has created (in-memory, like the E2B manager). */
  listSandboxes(): SandboxInfo[] {
    return Array.from(this.sandboxInfo.values())
  }

  /** List TextQL connectors visible to the API key's member. */
  async listConnectors(): Promise<ConnectorInfo[]> {
    return this.request<ConnectorInfo[]>('GET', '/v2/connectors')
  }

  /**
   * Read the ontology/context from the sandbox's read-only ./library mount:
   * full text of any ANA.md files + an index of available .tql paths. Returns a
   * formatted markdown block suitable for injecting into the agent's system
   * prompt (TextQL's ANA.md auto-load behavior). Returns '' if nothing found.
   */
  async getOntologyContext(sandboxId: string): Promise<string> {
    const code = [
      'import os, json, base64',
      'ana, tqls = [], []',
      "for r, _, fs in os.walk('library'):",
      '  for f in fs:',
      '    p = os.path.join(r, f)',
      "    if f.lower() == 'ana.md':",
      '      try:',
      "        ana.append((p, open(p, encoding='utf-8', errors='replace').read()))",
      '      except Exception:',
      '        pass',
      "    elif f.endswith('.tql'):",
      '      tqls.append(p)',
      "print('__SBX_RESULT__' + base64.b64encode(json.dumps({'ana': ana, 'tqls': sorted(tqls)}).encode()).decode())",
    ].join('\n')

    try {
      const res = await this.runPython(sandboxId, code)
      if (res.error) return ''
      const payload = this.extractPayload(res.output)
      if (!payload) return ''
      const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as {
        ana: Array<[string, string]>
        tqls: string[]
      }

      const parts: string[] = ['# Ontology & Context (mounted read-only at ./library)']

      if (data.ana.length > 0) {
        parts.push('\n## Business context (ANA.md — always applies)')
        let budget = 60000 // cap total ANA.md text injected (ANA.md is the source of truth — keep it whole)
        for (const [path, text] of data.ana) {
          const slice = text.slice(0, Math.max(0, budget))
          budget -= slice.length
          parts.push(`\n### ${path}\n${slice}`)
          if (budget <= 0) break
        }
      }

      if (data.tqls.length > 0) {
        const MAX = 200
        const shown = data.tqls.slice(0, MAX)
        parts.push(
          `\n## Governed queries available (${data.tqls.length} .tql files — run via query_connector with tql_path)`
        )
        parts.push(shown.join('\n'))
        if (data.tqls.length > MAX) {
          parts.push(`…and ${data.tqls.length - MAX} more. Use run_python (os.walk) to explore further.`)
        }
      }

      if (data.ana.length === 0 && data.tqls.length === 0) return ''
      return parts.join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Run a connector query and load the result into a sandbox DataFrame.
   * Pass EXACTLY ONE of `query` (raw SQL) or `tqlPath` (a saved .tql semantic query).
   */
  async queryConnector(
    sandboxId: string,
    opts: {
      connectorId: number
      query?: string
      tqlPath?: string
      dataframeName?: string
      params?: Record<string, unknown>
      maxRows?: number
    }
  ): Promise<QueryResult> {
    const body: Record<string, unknown> = { connector_id: opts.connectorId }
    if (opts.query) body.query = opts.query
    if (opts.tqlPath) body.tql_path = opts.tqlPath
    if (opts.dataframeName) body.dataframe_name = opts.dataframeName
    if (opts.params) body.params = opts.params
    if (opts.maxRows !== undefined) body.max_rows = opts.maxRows

    const res = await this.request<{
      dataframe_name: string
      num_rows: number
      num_cols: number
      preview: string
    }>('POST', `/v2/sandcastles/${sandboxId}/query`, body)

    return {
      dataframeName: res.dataframe_name,
      numRows: res.num_rows,
      numCols: res.num_cols,
      preview: res.preview,
    }
  }

  /**
   * Dry-run: preview pending edits in ./library (the ontology) without writing.
   * GET /v2/sandcastles/:id/library/diff
   */
  async diffLibrary(sandboxId: string): Promise<LibraryDiff> {
    const r = await this.request<{ has_changes: boolean; diffs?: LibraryDiff['diffs']; raw_diff?: string }>(
      'GET',
      `/v2/sandcastles/${sandboxId}/library/diff`
    )
    return { hasChanges: !!r.has_changes, diffs: r.diffs || [], rawDiff: r.raw_diff || '' }
  }

  /**
   * Persist the sandbox's ./library edits back to the org Context Library as a
   * reviewable patch (the ontology write / self-learning flywheel).
   * POST /v2/sandcastles/:id/library/patches
   */
  async createLibraryPatch(
    sandboxId: string,
    opts: { title: string; description: string; draft?: boolean; patchNumber?: number }
  ): Promise<LibraryPatch> {
    const body: Record<string, unknown> = { title: opts.title, description: opts.description }
    if (opts.draft !== undefined) body.draft = opts.draft
    if (opts.patchNumber !== undefined) body.patch_number = opts.patchNumber

    const r = await this.request<{
      patch_id: string
      patch_number: number
      status: string
      git_ref: string
      has_conflicts: boolean
      conflicts?: string
      auto_approved: boolean
      raw_diff?: string
    }>('POST', `/v2/sandcastles/${sandboxId}/library/patches`, body)

    return {
      patchId: r.patch_id,
      patchNumber: r.patch_number,
      status: r.status,
      gitRef: r.git_ref,
      hasConflicts: !!r.has_conflicts,
      conflicts: r.conflicts,
      autoApproved: !!r.auto_approved,
      rawDiff: r.raw_diff || '',
    }
  }

  /**
   * Run Python in the sandcastle. Returns the raw API response.
   * `print()` output is captured as an array of strings; errors null the output.
   */
  private async runPython(sandboxId: string, code: string): Promise<ExecuteApiResponse> {
    return this.request<ExecuteApiResponse>('POST', `/v2/sandcastles/${sandboxId}/execute`, { code })
  }

  /** Pull a shim's base64 payload back out of the captured output array. */
  private extractPayload(output: string[] | null): string | null {
    if (!output) return null
    for (const line of output) {
      if (line.startsWith(RESULT_MARKER)) return line.slice(RESULT_MARKER.length)
    }
    return null
  }

  private static b64(s: string): string {
    return Buffer.from(s, 'utf-8').toString('base64')
  }

  /**
   * Execute code in the sandcastle. Only Python is supported by the API;
   * any other language returns an error result.
   */
  async executeCode(
    sandboxId: string,
    code: string,
    language: 'python' | 'javascript' = 'python'
  ): Promise<ExecutionResult> {
    if (language !== 'python') {
      const message = `Sandcastle only supports Python execution (got "${language}")`
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
    try {
      const res = await this.runPython(sandboxId, code)
      return {
        stdout: (res.output || []).join('\n'),
        stderr: '',
        exitCode: res.error ? 1 : 0,
        error: res.error || undefined,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
  }

  /**
   * Execute a shell command. Shimmed via Python subprocess since the API has no
   * shell endpoint.
   */
  async executeCommand(sandboxId: string, command: string): Promise<ExecutionResult> {
    const code = [
      'import subprocess, json, base64',
      `_cmd = base64.b64decode("${SandcastleManager.b64(command)}").decode()`,
      '_r = subprocess.run(_cmd, shell=True, capture_output=True, text=True)',
      '_p = {"stdout": _r.stdout, "stderr": _r.stderr, "code": _r.returncode}',
      `print("${RESULT_MARKER}" + base64.b64encode(json.dumps(_p).encode()).decode())`,
    ].join('\n')

    try {
      const res = await this.runPython(sandboxId, code)
      if (res.error) {
        return { stdout: '', stderr: res.error, exitCode: 1, error: res.error }
      }
      const payload = this.extractPayload(res.output)
      if (!payload) {
        return { stdout: '', stderr: 'No result from sandcastle', exitCode: 1, error: 'No result' }
      }
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as {
        stdout: string
        stderr: string
        code: number
      }
      return { stdout: parsed.stdout, stderr: parsed.stderr, exitCode: parsed.code }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
  }

  /** Resolve a relative path against the sandcastle working directory. */
  private resolvePath(filePath: string): string {
    return filePath.startsWith('/') ? filePath : `${SANDBOX_WORKDIR}/${filePath}`
  }

  /** Write a file. Shimmed via Python so it lands in the execute working dir. */
  async writeFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    const code = [
      'import base64, os',
      `_p = base64.b64decode("${SandcastleManager.b64(this.resolvePath(filePath))}").decode()`,
      `_c = base64.b64decode("${Buffer.from(content, 'utf-8').toString('base64')}")`,
      '_d = os.path.dirname(_p)',
      'if _d: os.makedirs(_d, exist_ok=True)',
      'open(_p, "wb").write(_c)',
      `print("${RESULT_MARKER}OK")`,
    ].join('\n')

    const res = await this.runPython(sandboxId, code)
    if (res.error) throw new Error(res.error)
  }

  /** Read a file. Shimmed via Python; binary extensions come back base64. */
  async readFile(
    sandboxId: string,
    filePath: string
  ): Promise<{ content: string; encoding: 'text' | 'base64' }> {
    const ext = filePath.toLowerCase().split('.').pop() || ''
    const isBinary = BINARY_EXTENSIONS.includes(ext)

    const code = [
      'import base64',
      `_p = base64.b64decode("${SandcastleManager.b64(this.resolvePath(filePath))}").decode()`,
      '_d = open(_p, "rb").read()',
      `print("${RESULT_MARKER}" + base64.b64encode(_d).decode())`,
    ].join('\n')

    const res = await this.runPython(sandboxId, code)
    if (res.error) throw new Error(res.error)
    const payload = this.extractPayload(res.output)
    if (payload === null) throw new Error('Failed to read file')

    if (isBinary) {
      return { content: payload, encoding: 'base64' }
    }
    return { content: Buffer.from(payload, 'base64').toString('utf-8'), encoding: 'text' }
  }

  /** List files in a directory. Shimmed via Python. */
  async listFiles(sandboxId: string, dirPath: string = SANDBOX_WORKDIR): Promise<FileInfo[]> {
    const code = [
      'import base64, json, os',
      `_p = base64.b64decode("${SandcastleManager.b64(dirPath)}").decode()`,
      '_out = []',
      'try:',
      '  for e in os.scandir(_p):',
      '    _isdir = e.is_dir()',
      '    _out.append({"name": e.name, "type": "directory" if _isdir else "file", "size": (0 if _isdir else e.stat().st_size)})',
      'except FileNotFoundError:',
      '  pass',
      `print("${RESULT_MARKER}" + base64.b64encode(json.dumps(_out).encode()).decode())`,
    ].join('\n')

    try {
      const res = await this.runPython(sandboxId, code)
      if (res.error) return []
      const payload = this.extractPayload(res.output)
      if (payload === null) return []
      const entries = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Array<{
        name: string
        type: 'file' | 'directory'
        size: number
      }>
      return entries.map((entry) => ({
        name: entry.name,
        path: dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`,
        type: entry.type,
        size: entry.size,
      }))
    } catch {
      return []
    }
  }

  /**
   * Get or create a sandcastle.
   * Reuses an existing sandbox if it is still running; otherwise creates a new
   * one. The snapshot argument is ignored (worldlines dropped).
   */
  async getOrCreateSandbox(
    existingSandboxId?: string,
    _snapshotCommitSha?: string
  ): Promise<GetOrCreateSandboxResult> {
    if (existingSandboxId) {
      const alive = await this.getSandbox(existingSandboxId)
      if (alive) {
        return { sandboxId: existingSandboxId, isNew: false, wasRestored: false }
      }
      this.sandboxInfo.delete(existingSandboxId)
    }

    const newSandboxId = await this.createSandbox()
    return { sandboxId: newSandboxId, isNew: true, wasRestored: false }
  }

  /** Stop and destroy a sandcastle. */
  async killSandbox(sandboxId: string): Promise<void> {
    try {
      await this.request('DELETE', `/v2/sandcastles/${sandboxId}`)
    } finally {
      this.sandboxInfo.delete(sandboxId)
    }
  }

  /** Best-effort cleanup of all tracked sandcastles. */
  async cleanup(): Promise<void> {
    for (const id of Array.from(this.sandboxInfo.keys())) {
      try {
        await this.request('DELETE', `/v2/sandcastles/${id}`)
      } catch {
        // best effort
      }
    }
    this.sandboxInfo.clear()
  }

  // ---------------------------------------------------------------------------
  // Worldline / snapshot API — dropped. Retained as inert no-ops so existing
  // callers keep compiling. The Sandcastle API has no snapshot/pause/resume.
  // ---------------------------------------------------------------------------

  async createSnapshot(
    _sandboxId: string,
    _messageUuid: string,
    _commitMessage?: string
  ): Promise<SandboxSnapshot | null> {
    return null
  }

  async restoreSnapshot(_sandboxId: string, _commitSha: string): Promise<boolean> {
    return false
  }

  async getCurrentCommit(_sandboxId: string): Promise<string | null> {
    return null
  }

  async getSnapshotHistory(
    _sandboxId: string,
    _limit: number = 20
  ): Promise<Array<{ sha: string; message: string; date: string }>> {
    return []
  }

  async pauseSandbox(sandboxId: string): Promise<string> {
    // No pause in the Sandcastle API; sandboxes idle-reap on their own.
    return sandboxId
  }

  async resumeSandbox(sandboxId: string): Promise<string | null> {
    return this.getSandbox(sandboxId)
  }
}

// Singleton instance (named to match the E2B manager for drop-in imports)
export const sandboxManager = new SandcastleManager()
