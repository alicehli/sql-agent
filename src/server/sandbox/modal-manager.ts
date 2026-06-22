/**
 * Modal Sandbox Manager (comparison demo — lane A: generic sandbox, DIY connectors).
 *
 * Mirrors the subset of the sandcastle-manager interface the agent harness needs
 * (createSandbox / executeCode / killSandbox) so lane A and lane B can run the
 * SAME harness with only the backend swapped.
 *
 * Modal's SDK is Python-only, so this shells out to scripts/modal_op.py running in
 * the project's .modal-venv. Sandboxes are reconnected by id between calls.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

const PYTHON = process.env.MODAL_PYTHON || path.resolve(process.cwd(), '.modal-venv/bin/python')
const SCRIPT = path.resolve(process.cwd(), 'scripts/modal_op.py')
const MARK = '__MODAL__'

export interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

function runOp<T>(args: string[], stdin?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SCRIPT, ...args], { env: process.env })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith(MARK))
      if (!line) {
        reject(new Error(`modal_op ${args[0]} returned no result. stderr: ${err.slice(0, 500)}`))
        return
      }
      try {
        const payload = JSON.parse(Buffer.from(line.slice(MARK.length), 'base64').toString('utf-8'))
        if (payload.error) reject(new Error(payload.error))
        else resolve(payload as T)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    if (stdin !== undefined) {
      proc.stdin.write(stdin)
      proc.stdin.end()
    }
  })
}

export class ModalManager {
  /** Create a Modal sandbox (first call builds the image — slow, then cached). */
  async createSandbox(): Promise<string> {
    const { sandbox_id } = await runOp<{ sandbox_id: string }>(['create'])
    return sandbox_id
  }

  /** Run Python in the Modal sandbox. Code is sent base64 over stdin. */
  async executeCode(sandboxId: string, code: string): Promise<ExecutionResult> {
    try {
      const r = await runOp<{ stdout: string; stderr: string; exit_code: number }>(
        ['exec', sandboxId],
        Buffer.from(code, 'utf-8').toString('base64')
      )
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return { stdout: '', stderr: message, exitCode: 1, error: message }
    }
  }

  /** Terminate the Modal sandbox (best effort). */
  async killSandbox(sandboxId: string): Promise<void> {
    await runOp(['kill', sandboxId]).catch(() => {})
  }
}

export const modalManager = new ModalManager()
