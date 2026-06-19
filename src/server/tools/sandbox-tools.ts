/**
 * In-process SDK tools for sandcastle execution
 * These tools run in the same Node.js process as the backend
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { sandboxManager } from '../sandbox/sandcastle-manager'

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
 * Create the in-process MCP server with sandcastle tools
 */
export function createSandboxMcpServer() {
  return createSdkMcpServer({
    name: 'sandbox',
    version: '1.0.0',
    tools: [
      tool(
        'run_python',
        `Execute Python code in the sandcastle. Use this for ALL Python code execution.
The sandbox has a full Python environment with common packages (numpy, pandas, matplotlib, requests, etc.).
Files created will be saved in /sandbox/files and visible in the Sandbox Files panel.`,
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
        `Execute a shell command in the sandcastle.
Use this for shell operations like installing packages (pip install), file operations, etc.
Commands run in /sandbox/files by default.`,
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
        `Write content to a file in the sandcastle.
Files are saved relative to /sandbox/files unless an absolute path is given.`,
        {
          path: z.string().describe('File path (e.g., script.py or /sandbox/files/data.csv)'),
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
            const fullPath = path.startsWith('/') ? path : `/sandbox/files/${path}`
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
        `Read content from a file in the sandcastle.`,
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
            const fullPath = path.startsWith('/') ? path : `/sandbox/files/${path}`
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
        `List files in a directory in the sandcastle.`,
        {
          path: z.string().optional().describe('Directory path (default: /sandbox/files)'),
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
            const dirPath = path || '/sandbox/files'
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

      tool(
        'list_connectors',
        `List the TextQL data connectors you can query (id, name, type).
Use this to discover available data sources before calling query_connector.
The connectors shown are governed by your TextQL permissions (RBAC).`,
        {},
        async () => {
          try {
            const connectors = await sandboxManager.listConnectors()
            if (connectors.length === 0) {
              return { content: [{ type: 'text', text: '(no connectors available)' }] }
            }
            const rows = connectors.map((c) => `${c.id}\t${c.name}\t${c.type}`).join('\n')
            return { content: [{ type: 'text', text: `id\tname\ttype\n${rows}` }] }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `list_connectors error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'query_connector',
        `Run a query against a TextQL connector and load the result into a pandas DataFrame in the sandbox.
Provide a connector_id (from list_connectors) and EXACTLY ONE of:
  • query    — a raw SQL string, for ad-hoc exploration
  • tql_path — path to a saved .tql semantic query, for governed/ontology-aware access

Saved .tql files are mounted read-only at ./library in the sandbox; run list_files on "library" (or use run_python with os.walk) to discover them. The .tql backend must match the connector. Prefer tql_path for defined metrics/joins; use query for ad-hoc SQL.

The result loads as a DataFrame named dataframe_name (default: connector_<id> or the .tql filename) and is immediately usable from run_python.`,
        {
          connector_id: z.number().describe('Connector id (from list_connectors)'),
          query: z.string().optional().describe('Raw SQL string. Mutually exclusive with tql_path.'),
          tql_path: z
            .string()
            .optional()
            .describe('Path to a saved .tql file, e.g. library/databases/.../foo.tql. Mutually exclusive with query.'),
          dataframe_name: z.string().optional().describe('Name for the resulting DataFrame'),
          params: z.record(z.string(), z.unknown()).optional().describe('Parameters for a parameterized .tql query'),
          max_rows: z.number().optional().describe('Max rows to load (TQL path only)'),
        },
        async ({ connector_id, query, tql_path, dataframe_name, params, max_rows }) => {
          const sandboxId = await getOrCreateSandbox()
          if (!sandboxId) {
            return {
              content: [{ type: 'text', text: 'Error: No sandbox available. Please try again.' }],
              isError: true,
            }
          }

          const hasQuery = typeof query === 'string' && query.length > 0
          const hasTql = typeof tql_path === 'string' && tql_path.length > 0
          if (hasQuery === hasTql) {
            return {
              content: [{ type: 'text', text: 'Error: provide EXACTLY ONE of `query` or `tql_path`.' }],
              isError: true,
            }
          }

          try {
            const result = await sandboxManager.queryConnector(sandboxId, {
              connectorId: connector_id,
              query: hasQuery ? query : undefined,
              tqlPath: hasTql ? tql_path : undefined,
              dataframeName: dataframe_name,
              params,
              maxRows: max_rows,
            })
            return {
              content: [
                {
                  type: 'text',
                  text: `Loaded DataFrame "${result.dataframeName}" (${result.numRows} rows × ${result.numCols} cols)\n\n${result.preview}`,
                },
              ],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `query_connector error: ${error}` }],
              isError: true,
            }
          }
        }
      ),
    ],
  })
}
