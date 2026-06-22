/**
 * Comparison demo — lane runners (multi-turn).
 *
 * Lanes A and B run the SAME harness (Claude Agent SDK `query()`); only the
 * backend behind `run_python` differs:
 *   - lane A ("modal")      → generic sandbox, the DIY path
 *   - lane B ("sandcastle") → TextQL Sandcastle
 * Lane C ("ana") is the full TextQL agent via /v2/chats/stream.
 *
 * Each lane keeps a LaneSession (live sandbox + agent resume id / Ana chat id) so
 * follow-up turns continue the same conversation. Sandboxes are NOT killed between
 * turns — they self-expire, and /api/compare/reset kills them explicitly.
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { modalManager } from '../sandbox/modal-manager'
import { sandboxManager } from '../sandbox/sandcastle-manager'
import type { LaneSession } from './sessions'

export type LaneEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; code?: string }
  | { type: 'tool_result'; ok: boolean; output?: string }
  | { type: 'asset'; name: string; url?: string }
  | { type: 'file'; name: string; size: number }
  | { type: 'metrics'; inputTokens: number; outputTokens: number; totalTokens: number; toolCalls: number; elapsedMs: number; setupMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

type Emit = (e: LaneEvent) => void

const SHARED_SYSTEM_PROMPT = `You are a data analyst working in a Python sandbox, available through the run_python tool.
For ANY data question, once you have the data you MUST create a visualization in the SAME turn: write and run matplotlib code to plot it and save the figure as a PNG in the working directory. Do this proactively — never just describe the numbers in text, and never wait to be asked for a chart. Then briefly summarize. Keep it concise.`

const MODEL = process.env.COMPARE_MODEL || 'sonnet'
// Lane C just orchestrates the MCP poll loop — a fast/cheap model keeps the
// per-poll inference latency (the main overhead) low.
const MCP_MODEL = process.env.COMPARE_MCP_MODEL || 'sonnet'
const CONNECTOR_ID = Number(process.env.COMPARE_CONNECTOR_ID || 628)
// Ana auto-persists charts as TextQL dashboards; for the demo we want the chart
// returned inline without cluttering the org with dashboards.
const NO_DASHBOARD_NOTE =
  ' Important: return the chart/visualization inline in your answer (an image or artifact link is fine), but do NOT create or save a TextQL dashboard.'

// Lane A: no prebuilt connector — wire Snowflake yourself.
const DIY_NOTE = `

DATA ACCESS — you must wire it up yourself (there is NO prebuilt connector or semantic layer):
A Snowflake warehouse is reachable via the \`snowflake.connector\` Python package using these env vars:
SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_DATABASE (US_REAL_ESTATE), SNOWFLAKE_SCHEMA (CYBERSYN), SNOWFLAKE_ROLE.
Import snowflake.connector, connect, discover tables via US_REAL_ESTATE.INFORMATION_SCHEMA.COLUMNS/TABLES, then query and load results into pandas yourself. Handle the Snowflake SQL dialect on your own.
CRITICAL: each run_python call runs in a FRESH process — variables, imports, and DB connections do NOT persist between calls. Do the entire task (connect → query → analyze → save the chart PNG) in a SINGLE run_python call, or persist intermediate data to disk (CSV/parquet) and reload it next call. Don't rely on a variable defined in a previous call.`

// Lane B: prebuilt governed connector via the query_connector tool.
const CONNECTOR_NOTE = `

DATA ACCESS — use the prebuilt governed connector (don't write raw connection code):
Use the query_connector tool to load data from TextQL connector_id ${CONNECTOR_ID} (US Real Estate Cybersyn) straight into a pandas DataFrame. It runs Snowflake SQL against US_REAL_ESTATE.CYBERSYN. run_python keeps state across calls, so loaded DataFrames persist; pass a "query" (raw SQL) to query_connector, then analyze + plot with run_python.

ONTOLOGY FLYWHEEL — this is the most important part of your workflow:
STEP 1 (ALWAYS FIRST): before doing anything else, inspect the mounted Context Library with run_python — walk ./library and read any .tql / .md files (e.g. \`import os; [print(p) for r,_,fs in os.walk('library') for p in [os.path.join(r,f) for f in fs]]\` then print the contents). If a saved query or schema note already answers this question, REUSE it directly (run the saved .tql via query_connector with tql_path, or copy its SQL) and skip schema exploration entirely. A warm library should let you finish in 1–2 tool calls.
STEP 2: if the library does NOT already cover it, explore as needed. SCHEMA HINT: the Freddie Mac house price index is in US_REAL_ESTATE.CYBERSYN.FREDDIE_MAC_HOUSING_TIMESERIES; national-level series use a country-level GEO_ID (e.g. 'country/USA').
STEP 3 (ALWAYS LAST, after you produce the chart): persist what you learned so the NEXT run is faster. Write a reusable parameterizable .tql query AND a short .md schema note under ./library via run_python (only if not already present), then call save_to_ontology with a clear title + description. This is the self-learning loop — do it every time you discover something new.`

interface SandboxBackend {
  createSandbox(): Promise<string>
  executeCode(sandboxId: string, code: string): Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>
}

// Lists files the agent created in the working dir; inlines images as base64.
// Works for both Modal and Sandcastle (both run Python).
const ARTIFACT_SNIPPET = [
  'import os, json, base64',
  'SKIP = {"library", "__pycache__"}',
  'IMG = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")',
  '_items = []',
  'try:',
  '  for _f in sorted(os.listdir(".")):',
  '    if _f.startswith(".") or _f in SKIP: continue',
  '    if not os.path.isfile(_f): continue',
  '    _sz = os.path.getsize(_f)',
  '    _it = {"name": _f, "size": _sz}',
  '    if _f.lower().endswith(IMG) and _sz < 4000000:',
  '      _ext = _f.lower().rsplit(".", 1)[-1]',
  '      _it["mime"] = "image/jpeg" if _ext in ("jpg","jpeg") else ("image/svg+xml" if _ext=="svg" else "image/"+_ext)',
  '      _it["b64"] = base64.b64encode(open(_f, "rb").read()).decode()',
  '    _items.append(_it)',
  'except Exception:',
  '  pass',
  'print("__ARTIFACTS__" + base64.b64encode(json.dumps(_items).encode()).decode())',
].join('\n')

async function collectArtifacts(mgr: SandboxBackend, sandboxId: string, emit: Emit): Promise<void> {
  try {
    const r = await mgr.executeCode(sandboxId, ARTIFACT_SNIPPET)
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__ARTIFACTS__'))
    if (!line) return
    const items = JSON.parse(
      Buffer.from(line.slice('__ARTIFACTS__'.length), 'base64').toString('utf-8')
    ) as Array<{ name: string; size: number; b64?: string; mime?: string }>
    for (const it of items) {
      if (it.b64 && it.mime) emit({ type: 'asset', name: it.name, url: `data:${it.mime};base64,${it.b64}` })
      else emit({ type: 'file', name: it.name, size: it.size })
    }
  } catch {
    // artifacts are best-effort
  }
}

/** Lane A / B: same Claude harness, swappable sandbox backend, multi-turn via sess. */
export async function runSandboxLane(opts: {
  backend: 'modal' | 'sandcastle'
  question: string
  emit: Emit
  sess: LaneSession
}): Promise<void> {
  const { backend, question, emit, sess } = opts
  const mgr: SandboxBackend = backend === 'modal' ? modalManager : sandboxManager
  const start = Date.now()
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0

  try {
    if (sess.sandboxId) {
      emit({ type: 'status', text: 'reusing sandbox…' })
    } else {
      emit({ type: 'status', text: 'creating sandbox…' })
      sess.sandboxId = await mgr.createSandbox()
    }
    const sandboxId = sess.sandboxId
    emit({ type: 'status', text: `sandbox ready (${sandboxId.slice(0, 18)}…)` })
    // Time the agent loop separately from sandbox setup (Modal cold-start/image
    // build would otherwise dwarf the actual work on the first turn).
    const agentStart = Date.now()

    const mcp = createSdkMcpServer({
      name: 'sbx',
      version: '1.0.0',
      tools: [
        tool(
          'run_python',
          'Execute Python code in the sandbox and return its stdout/stderr.',
          { code: z.string().describe('Python code to run') },
          async ({ code }) => {
            toolCalls++
            emit({ type: 'tool', name: 'run_python', code })
            const r = await mgr.executeCode(sandboxId, code)
            const parts: string[] = []
            if (r.stdout) parts.push(`STDOUT:\n${r.stdout}`)
            if (r.stderr) parts.push(`STDERR:\n${r.stderr}`)
            if (r.error) parts.push(`ERROR: ${r.error}`)
            const text = parts.join('\n\n') || '(no output)'
            emit({ type: 'tool_result', ok: r.exitCode === 0, output: text.slice(0, 1200) })
            return { content: [{ type: 'text', text }], isError: r.exitCode !== 0 }
          }
        ),
        ...(backend === 'sandcastle'
          ? [
              tool(
                'query_connector',
                'Load data from a prebuilt TextQL connector into a pandas DataFrame. Provide connector_id and exactly one of query (SQL) or tql_path.',
                {
                  connector_id: z.number().optional(),
                  query: z.string().optional(),
                  tql_path: z.string().optional(),
                  dataframe_name: z.string().optional(),
                },
                async ({ connector_id, query: q, tql_path, dataframe_name }) => {
                  toolCalls++
                  emit({ type: 'tool', name: 'query_connector', code: q || tql_path || `connector ${connector_id ?? CONNECTOR_ID}` })
                  try {
                    const r = await sandboxManager.queryConnector(sandboxId, {
                      connectorId: connector_id ?? CONNECTOR_ID,
                      query: q,
                      tqlPath: tql_path,
                      dataframeName: dataframe_name,
                    })
                    emit({ type: 'tool_result', ok: true, output: `${r.dataframeName} (${r.numRows}×${r.numCols})\n${r.preview}`.slice(0, 1200) })
                    return { content: [{ type: 'text', text: `Loaded DataFrame "${r.dataframeName}" (${r.numRows}×${r.numCols})\n\n${r.preview}` }] }
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    emit({ type: 'tool_result', ok: false, output: msg.slice(0, 1200) })
                    return { content: [{ type: 'text', text: `query_connector error: ${msg}` }], isError: true }
                  }
                }
              ),
              tool('list_connectors', 'List available TextQL connectors (id, name, type).', {}, async () => {
                const cs = await sandboxManager.listConnectors()
                return { content: [{ type: 'text', text: cs.map((c) => `${c.id}\t${c.name}\t${c.type}`).join('\n') || '(none)' }] }
              }),
              tool(
                'save_to_ontology',
                'Persist your edits in ./library back to the org Context Library as a reviewable patch (the self-learning ontology flywheel). First write or modify a .tql / .md file under ./library via run_python, then call this with a title and description.',
                {
                  title: z.string().describe('Short patch title (≤50 chars)'),
                  description: z.string().describe('Markdown explanation of the change'),
                },
                async ({ title, description }) => {
                  toolCalls++
                  emit({ type: 'tool', name: 'save_to_ontology', code: title })
                  try {
                    const p = await sandboxManager.createLibraryPatch(sandboxId, { title, description })
                    const summary = `patch ${p.patchId} (#${p.patchNumber}) · status=${p.status}${p.autoApproved ? ' · auto-approved' : ''}${p.hasConflicts ? ' · CONFLICTS' : ''}`
                    emit({ type: 'tool_result', ok: !p.hasConflicts, output: summary })
                    return { content: [{ type: 'text', text: summary }], isError: p.hasConflicts }
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e)
                    emit({ type: 'tool_result', ok: false, output: msg.slice(0, 800) })
                    return { content: [{ type: 'text', text: `save_to_ontology error: ${msg}` }], isError: true }
                  }
                }
              ),
            ]
          : []),
      ],
    })

    const allowedTools =
      backend === 'sandcastle'
        ? ['mcp__sbx__run_python', 'mcp__sbx__query_connector', 'mcp__sbx__list_connectors', 'mcp__sbx__save_to_ontology']
        : ['mcp__sbx__run_python']
    const systemPrompt = SHARED_SYSTEM_PROMPT + (backend === 'modal' ? DIY_NOTE : CONNECTOR_NOTE)

    for await (const msg of query({
      prompt: question,
      options: {
        mcpServers: { sbx: mcp },
        allowedTools,
        model: MODEL,
        systemPrompt,
        maxTurns: 100,
        permissionMode: 'bypassPermissions',
        ...(sess.resumeId ? { resume: sess.resumeId } : {}),
      } as Parameters<typeof query>[0]['options'],
    })) {
      const sid = (msg as { session_id?: string }).session_id
      if (sid) sess.resumeId = sid
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content || []
        for (const block of content) {
          if (block.type === 'text' && block.text) emit({ type: 'text', text: block.text })
        }
      } else if (msg.type === 'result') {
        const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
        if (usage) {
          inputTokens = usage.input_tokens || 0
          outputTokens = usage.output_tokens || 0
        }
      }
    }

    emit({ type: 'status', text: 'collecting artifacts…' })
    await collectArtifacts(mgr, sandboxId, emit)

    emit({
      type: 'metrics',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      toolCalls,
      elapsedMs: Date.now() - agentStart,
      setupMs: agentStart - start,
    })
    emit({ type: 'done' })
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  // NB: sandbox intentionally kept alive for follow-up turns (reset/expiry/idle-sweep cleans up).
}

// Lane C system prompt: Claude has no DB access; it delegates to Ana via MCP.
const MCP_SYSTEM_PROMPT = `You are a data analyst with NO direct database or sandbox access. Delegate to Ana — TextQL's data agent — over MCP, using its ASYNC tools (the synchronous "ana" tool times out on real analyses):
1) Call ana_ask EXACTLY ONCE with: question (restate the full request, and explicitly tell Ana to return the chart inline but NOT create or save a TextQL dashboard) and tools: { connector_ids: [${CONNECTOR_ID}], python_enabled: true, sql_enabled: true, ontology_enabled: true } — everything MUST be nested inside the "tools" object. connector_ids attaches the US Real Estate Cybersyn connector (without it Ana reports the connector is not attached), and python/sql/ontology must be enabled or Ana can't actually run the analysis. It returns a chat_id and a cursor.
2) Then call ana_poll with that chat_id and the latest cursor REPEATEDLY until the response status is "complete" (or "error"). Ana can take a minute or more — keep polling patiently while status is "running"; pass the newest cursor each time. Do NOT call ana_ask again.
3) When complete, relay Ana's actual findings plus the chat link where the chart can be viewed.
BE HONEST: Ana queries the data and builds the chart inside its OWN thread (reachable only via the link). You did NOT render a chart inline, and it is NOT necessarily matplotlib — do not claim you produced an inline or matplotlib chart. Just summarize what Ana found and give the link, e.g. "Ana queried the data and built a chart — view it here: <link>".`

/**
 * Lane C: Claude Agent SDK (harness) connected to TextQL's hosted MCP server, so
 * Claude delegates data questions to Ana via the `ana` tool. Multi-turn via resume.
 */
export async function runMcpLane(opts: { question: string; emit: Emit; sess: LaneSession }): Promise<void> {
  const { question, emit, sess } = opts
  const start = Date.now()
  let toolCalls = 0
  let inputTokens = 0
  let outputTokens = 0
  const base = (process.env.SANDBOX_BASE_URL || 'https://app.textql.com').replace(/\/+$/, '')
  const key = process.env.SANDBOX_API_KEY
  if (!key) {
    emit({ type: 'error', message: 'SANDBOX_API_KEY not set' })
    return
  }

  try {
    emit({ type: 'status', text: sess.resumeId ? 'continuing…' : 'connecting to Ana MCP…' })
    for await (const msg of query({
      prompt: question,
      options: {
        mcpServers: {
          ana: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } },
        },
        allowedTools: ['mcp__ana__ana_ask', 'mcp__ana__ana_poll'],
        disallowedTools: ['mcp__ana__ana', 'mcp__ana__list_connectors'],
        model: MCP_MODEL,
        systemPrompt: MCP_SYSTEM_PROMPT,
        maxTurns: 90,
        permissionMode: 'bypassPermissions',
        ...(sess.resumeId ? { resume: sess.resumeId } : {}),
      } as Parameters<typeof query>[0]['options'],
    })) {
      const sid = (msg as { session_id?: string }).session_id
      if (sid) sess.resumeId = sid
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }).message?.content || []
        for (const block of content) {
          if (block.type === 'text' && block.text) emit({ type: 'text', text: block.text })
          else if (block.type === 'tool_use') {
            toolCalls++
            emit({ type: 'tool', name: (block.name || 'tool').replace('mcp__ana__', 'ana:'), code: JSON.stringify(block.input ?? {}).slice(0, 500) })
          }
        }
      } else if (msg.type === 'user') {
        const content = (msg as { message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> } }).message?.content || []
        for (const block of content) {
          if (block.type === 'tool_result') {
            const out = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<{ text?: string }>).map((c) => c.text || '').join('\n')
                : ''
            emit({ type: 'tool_result', ok: !block.is_error, output: out.slice(0, 1200) })
          }
        }
      } else if (msg.type === 'result') {
        const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage
        if (usage) {
          inputTokens = usage.input_tokens || 0
          outputTokens = usage.output_tokens || 0
        }
      }
    }
    emit({ type: 'metrics', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, toolCalls, elapsedMs: Date.now() - start, setupMs: 0 })
    emit({ type: 'done' })
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** Lane D: the full TextQL agent via Ana chat-stream, multi-turn via chat_id. */
export async function runAnaLane(opts: {
  question: string
  emit: Emit
  sess: LaneSession
  connectorIds?: number[]
}): Promise<void> {
  const { question, emit, sess } = opts
  const start = Date.now()
  const base = (process.env.SANDBOX_BASE_URL || 'https://app.textql.com').replace(/\/+$/, '')
  const key = process.env.SANDBOX_API_KEY
  if (!key) {
    emit({ type: 'error', message: 'SANDBOX_API_KEY not set' })
    return
  }

  try {
    emit({ type: 'status', text: sess.chatId ? 'continuing Ana chat…' : 'calling Ana…' })
    const q = question + NO_DASHBOARD_NOTE
    const body: Record<string, unknown> = sess.chatId
      ? { question: q, chat_id: sess.chatId }
      : {
          question: q,
          tools: {
            python_enabled: true,
            sql_enabled: true,
            ontology_enabled: true,
            connector_ids: opts.connectorIds?.length ? opts.connectorIds : [CONNECTOR_ID],
          },
        }

    const res = await fetch(`${base}/v2/chats/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok || !res.body) {
      emit({ type: 'error', message: `Ana HTTP ${res.status}` })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let fullText = ''
    let toolCalls = 0
    const toolRe = /\[(?:MCP Tool: )?([^\]]+?) Execution Succeeded\]/g
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() || ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!line) continue
        let ev: { type?: string; text?: string; chat_id?: string; asset?: { name?: string; url?: string } }
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        if (ev.type === 'metadata' && ev.chat_id) sess.chatId = ev.chat_id
        else if (ev.type === 'text' && ev.text) {
          emit({ type: 'text', text: ev.text })
          fullText += ev.text
          const matches = fullText.match(/Execution Succeeded\]/g)
          const n = matches ? matches.length : 0
          if (n > toolCalls) {
            toolRe.lastIndex = 0
            const names: string[] = []
            let mm: RegExpExecArray | null
            while ((mm = toolRe.exec(fullText))) names.push(mm[1])
            for (let i = toolCalls; i < n; i++) emit({ type: 'tool', name: (names[i] || 'tool').slice(0, 40) })
            toolCalls = n
          }
        } else if (ev.type === 'asset' && ev.asset) emit({ type: 'asset', name: ev.asset.name || 'asset', url: ev.asset.url })
      }
    }

    emit({ type: 'metrics', inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls, elapsedMs: Date.now() - start, setupMs: 0 })
    emit({ type: 'done' })
  } catch (e) {
    emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
