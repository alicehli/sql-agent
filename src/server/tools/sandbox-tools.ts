/**
 * In-process SDK tools for E2B sandbox execution
 * These tools run in the same Node.js process as the backend
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { sandboxManager } from '../sandbox/e2b-manager'

// The sandbox is resolved per-connection by the provider (set by the server), which
// reads the authoritative per-WebSocket maps. SDK tool handlers lack request-context
// injection, so the provider is the single indirection — there is no separate cached
// "current sandbox" here to drift out of sync. (For true concurrency across
// simultaneous connections, the provider's notion of "current connection" would move
// to AsyncLocalStorage around the SDK query loop.)
let sandboxProvider: (() => Promise<string | null>) | null = null

export function setSandboxProvider(provider: () => Promise<string | null>) {
  sandboxProvider = provider
}

// Resolve the sandbox for the active connection - used by tools that need a sandbox.
async function getOrCreateSandbox(): Promise<string | null> {
  return sandboxProvider ? sandboxProvider() : null
}

/**
 * Create the in-process MCP server with E2B tools
 */
export function createSandboxMcpServer() {
  return createSdkMcpServer({
    name: 'sandbox',
    version: '1.0.0',
    tools: [
      tool(
        'run_python',
        `Execute Python code in the E2B sandbox. Use this for ALL Python code execution.
The sandbox has a full Python environment with common packages (numpy, pandas, matplotlib, requests, etc.).
Files created will be saved in /home/user and visible in the Sandbox Files panel.`,
        {
          code: z.string().describe('The Python code to execute'),
        },
        async ({ code }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available. Please try again.' }],
              isError: true,
            }
          }

          try {
            const result = await sandboxManager.executeCode(sandboxId, code, 'python')

            const parts: string[] = []
            if (result.stdout) parts.push(`STDOUT:\n${result.stdout}`)
            if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
            if (result.error) parts.push(`ERROR: ${result.error}`)
            if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)

            const output = parts.length > 0 ? parts.join('\n\n') : '(no output)'

            return {
              content: [{ type: 'text', text: output }],
              isError: result.exitCode !== 0,
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Execution error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'run_command',
        `Execute a shell command in the E2B sandbox.
Use this for shell operations like installing packages (pip install), file operations, etc.
Commands run in /home/user by default.`,
        {
          command: z.string().describe('The shell command to execute'),
        },
        async ({ command }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available. Please try again.' }],
              isError: true,
            }
          }

          try {
            const result = await sandboxManager.executeCommand(sandboxId, command)

            const parts: string[] = []
            if (result.stdout) parts.push(`${result.stdout}`)
            if (result.stderr) parts.push(`STDERR:\n${result.stderr}`)
            if (result.exitCode !== 0) parts.push(`Exit code: ${result.exitCode}`)

            const output = parts.length > 0 ? parts.join('\n\n') : '(no output)'

            return {
              content: [{ type: 'text', text: output }],
              isError: result.exitCode !== 0,
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Command error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'write_file',
        `Write content to a file in the E2B sandbox.
Files are saved relative to /home/user unless an absolute path is given.`,
        {
          path: z.string().describe('File path (e.g., script.py or /home/user/data.csv)'),
          content: z.string().describe('Content to write to the file'),
        },
        async ({ path, content }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available.' }],
              isError: true,
            }
          }

          try {
            // Normalize path
            const fullPath = path.startsWith('/') ? path : `/home/user/${path}`
            await sandboxManager.writeFile(sandboxId, fullPath, content)

            return {
              content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${fullPath}` }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Write error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'read_file',
        `Read content from a file in the E2B sandbox.`,
        {
          path: z.string().describe('File path to read'),
        },
        async ({ path }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available.' }],
              isError: true,
            }
          }

          try {
            const fullPath = path.startsWith('/') ? path : `/home/user/${path}`
            const { content } = await sandboxManager.readFile(sandboxId, fullPath)

            return {
              content: [{ type: 'text', text: content }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Read error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'list_files',
        `List files in a directory in the E2B sandbox.`,
        {
          path: z.string().optional().describe('Directory path (default: /home/user)'),
        },
        async ({ path }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available.' }],
              isError: true,
            }
          }

          try {
            const dirPath = path || '/home/user'
            const files = await sandboxManager.listFiles(sandboxId, dirPath)

            if (files.length === 0) {
              return {
                content: [{ type: 'text', text: '(empty directory)' }],
              }
            }

            const listing = files
              .map((f) => `${f.type === 'directory' ? 'DIR ' : 'FILE'} ${f.name}`)
              .join('\n')

            return {
              content: [{ type: 'text', text: listing }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `List error: ${error}` }],
              isError: true,
            }
          }
        }
      ),
    ],
  })
}
