/**
 * In-process SDK tools for SQL queries against DuckDB
 * Uses TPC-H sample data (scale factor 0.1)
 *
 * Uses DuckDB CLI binary instead of Node module for easier deployment
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { getDuckDBPath } from '../lib/duckdb'

const execFileAsync = promisify(execFile)

const MAX_ROWS = 100
const MAX_CHARS = 50000

// Path to persist the TPC-H database
const DB_PATH = path.join(os.homedir(), '.claude', 'tpch.duckdb')

// Initialize database with TPC-H data if not exists
let dbInitialized = false

async function ensureDbInitialized(): Promise<string> {
  const duckdbPath = getDuckDBPath()

  if (dbInitialized && fs.existsSync(DB_PATH)) {
    return duckdbPath
  }

  // Create directory if needed
  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  // Check if DB already has TPC-H data
  if (fs.existsSync(DB_PATH)) {
    try {
      const result = execSync(`${duckdbPath} "${DB_PATH}" -c "SELECT COUNT(*) FROM customer"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      if (result.includes('15000') || result.includes('1500')) {
        dbInitialized = true
        return duckdbPath
      }
    } catch {
      // DB exists but no data, will initialize
    }
  }

  // Initialize with TPC-H data
  try {
    execSync(`${duckdbPath} "${DB_PATH}" -c "INSTALL tpch; LOAD tpch; CALL dbgen(sf=0.1);"`, {
      encoding: 'utf-8',
      timeout: 60000,
    })
    dbInitialized = true
  } catch (error) {
    throw error
  }

  return duckdbPath
}

async function runQuery(sql: string): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  const duckdbPath = await ensureDbInitialized()

  // Use JSON output for easier parsing
  const fullSql = `${sql.replace(/;?\s*$/, '')};`

  try {
    // Use execFile (no shell): the SQL is passed as a single argv element, so
    // generated SQL containing shell metacharacters ($(), backticks, quotes) cannot
    // be interpreted by a shell. Avoids command injection from LLM/prompt-injected SQL.
    const { stdout } = await execFileAsync(
      duckdbPath,
      [DB_PATH, '-json', '-c', fullSql],
      { maxBuffer: 10 * 1024 * 1024 } // 10MB buffer
    )

    const trimmed = stdout.trim()
    if (!trimmed || trimmed === '[]') {
      return { rows: [], columns: [] }
    }

    const rows = JSON.parse(trimmed) as Record<string, unknown>[]
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : []

    return { rows, columns }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error)
    throw new Error(`SQL Error: ${errMsg}`)
  }
}

function formatTable(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return '(no rows)'

  // Calculate column widths
  const widths: number[] = columns.map((col) => col.length)
  for (const row of rows) {
    columns.forEach((col, i) => {
      const val = String(row[col] ?? '')
      widths[i] = Math.max(widths[i]!, val.length)
    })
  }

  // Build table
  const lines: string[] = []

  // Header
  const header = columns.map((col, i) => col.padEnd(widths[i]!)).join(' | ')
  lines.push(header)
  lines.push(widths.map((w) => '-'.repeat(w)).join('-+-'))

  // Rows
  for (const row of rows) {
    const line = columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i]!)).join(' | ')
    lines.push(line)
  }

  return lines.join('\n')
}

/**
 * Create the in-process MCP server with SQL tools
 */
export function createSqlMcpServer() {
  return createSdkMcpServer({
    name: 'sql',
    version: '1.0.0',
    tools: [
      tool(
        'query',
        `Execute a SQL query against the DuckDB database with TPC-H sample data.

Available tables:
- customer (~15,000 rows): c_custkey, c_name, c_address, c_nationkey, c_phone, c_acctbal, c_mktsegment, c_comment
- orders (~150,000 rows): o_orderkey, o_custkey, o_orderstatus, o_totalprice, o_orderdate, o_orderpriority, o_clerk, o_shippriority, o_comment
- lineitem (~600,000 rows): l_orderkey, l_partkey, l_suppkey, l_linenumber, l_quantity, l_extendedprice, l_discount, l_tax, l_returnflag, l_linestatus, l_shipdate, l_commitdate, l_receiptdate, l_shipinstruct, l_shipmode, l_comment
- part (~20,000 rows): p_partkey, p_name, p_mfgr, p_brand, p_type, p_size, p_container, p_retailprice, p_comment
- supplier (~1,000 rows): s_suppkey, s_name, s_address, s_nationkey, s_phone, s_acctbal, s_comment
- partsupp (~80,000 rows): ps_partkey, ps_suppkey, ps_availqty, ps_supplycost, ps_comment
- nation (25 rows): n_nationkey, n_name, n_regionkey, n_comment
- region (5 rows): r_regionkey, r_name, r_comment

Use standard SQL syntax. Results are limited to ${MAX_ROWS} rows.`,
        {
          sql: z.string().describe('The SQL query to execute'),
        },
        async ({ sql }) => {
          try {
            const { rows, columns } = await runQuery(sql)

            if (rows.length === 0) {
              return {
                content: [{ type: 'text', text: '(no rows returned)' }],
              }
            }

            let output = formatTable(rows, columns)

            if (output.length > MAX_CHARS) {
              output = output.slice(0, MAX_CHARS) + `\n\n⚠️ Output truncated at ${MAX_CHARS.toLocaleString()} characters.`
            }

            return {
              content: [{ type: 'text', text: output }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'list_tables',
        `List all available tables in the database.`,
        {},
        async () => {
          try {
            const { rows } = await runQuery('SHOW TABLES')
            const tables = rows.map((r) => Object.values(r)[0]).join('\n')

            return {
              content: [{ type: 'text', text: `Available tables:\n${tables}` }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Error: ${error}` }],
              isError: true,
            }
          }
        }
      ),

      tool(
        'describe_table',
        `Get the schema (columns and types) for a specific table.`,
        {
          table_name: z.string().describe('Name of the table to describe'),
        },
        async ({ table_name }) => {
          // Basic validation
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table_name)) {
            return {
              content: [{ type: 'text', text: 'Error: Invalid table name' }],
              isError: true,
            }
          }

          try {
            const { rows, columns } = await runQuery(`DESCRIBE ${table_name}`)

            if (rows.length === 0) {
              return {
                content: [{ type: 'text', text: `Table '${table_name}' not found` }],
                isError: true,
              }
            }

            const output = formatTable(rows, columns)

            return {
              content: [{ type: 'text', text: output }],
            }
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Error: ${error}` }],
              isError: true,
            }
          }
        }
      ),
    ],
  })
}
