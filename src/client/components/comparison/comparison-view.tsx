import { useRef, useState } from 'react'

type LaneId = 'modal' | 'sandcastle' | 'mcp' | 'ana'

interface LaneMetrics {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolCalls: number
  elapsedMs: number
  setupMs: number
}

interface Asset {
  name: string
  url?: string
}

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; code?: string; ok?: boolean; output?: string }

interface Turn {
  q: string
  status: string
  parts: Part[]
  assets: Asset[]
  files: { name: string; size: number }[]
  metrics?: LaneMetrics
  error?: string
  running: boolean
}

const LANES: { id: LaneId; title: string; sub: string }[] = [
  { id: 'modal', title: 'A · Generic sandbox', sub: 'Claude Agent SDK (harness) + Modal (DIY)' },
  { id: 'sandcastle', title: 'B · TextQL Sandcastle', sub: 'Claude Agent SDK (harness) + Sandcastle' },
  { id: 'mcp', title: 'C · Ana via MCP', sub: 'Claude Agent SDK (harness) + TextQL MCP → Ana' },
  { id: 'ana', title: 'D · Ana API', sub: 'direct /v2/chats call' },
]

const FONT = { fontFamily: "'JetBrains Mono', monospace" } as const
const isImageName = (s?: string) => !!s && /\.(png|jpe?g|gif|webp|svg)$/i.test(s)
const toolCount = (t?: Turn) => (t ? t.parts.filter((p) => p.kind === 'tool').length : 0)

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function newTurn(q: string): Turn {
  return { q, status: 'starting…', parts: [], assets: [], files: [], running: true }
}

const newSessionId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

export function ComparisonView() {
  const [question, setQuestion] = useState(
    'From the CYBERSYN US real-estate data (Freddie Mac housing timeseries), chart the national house price index over time.'
  )
  const [lanes, setLanes] = useState<Record<LaneId, Turn[]>>({ modal: [], sandcastle: [], mcp: [], ana: [] })
  const [running, setRunning] = useState<Record<LaneId, boolean>>({ modal: false, sandcastle: false, mcp: false, ana: false })
  const [drafts, setDrafts] = useState<Record<LaneId, string>>({ modal: '', sandcastle: '', mcp: '', ana: '' })
  const sessionId = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  if (!sessionId.current) sessionId.current = newSessionId()

  const anyRunning = running.modal || running.sandcastle || running.mcp || running.ana

  function patchLast(id: LaneId, fn: (t: Turn) => Turn) {
    setLanes((prev) => {
      const arr = prev[id]
      if (arr.length === 0) return prev
      const next = arr.slice()
      next[next.length - 1] = fn(next[next.length - 1])
      return { ...prev, [id]: next }
    })
  }

  function handleEvent(id: LaneId, ev: Record<string, unknown>) {
    const type = ev.type as string
    if (type === 'status') patchLast(id, (t) => ({ ...t, status: String(ev.text || '') }))
    else if (type === 'text')
      patchLast(id, (t) => {
        const parts = t.parts.slice()
        const lastP = parts[parts.length - 1]
        if (lastP && lastP.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: lastP.text + String(ev.text || '') }
        else parts.push({ kind: 'text', text: String(ev.text || '') })
        return { ...t, parts }
      })
    else if (type === 'tool')
      patchLast(id, (t) => ({
        ...t,
        status: 'working…',
        parts: [...t.parts, { kind: 'tool', name: String(ev.name || 'tool'), code: ev.code as string | undefined }],
      }))
    else if (type === 'tool_result')
      patchLast(id, (t) => {
        const parts = t.parts.slice()
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]
          if (p.kind === 'tool' && p.ok === undefined) {
            parts[i] = { ...p, ok: Boolean(ev.ok), output: ev.output as string | undefined }
            break
          }
        }
        return { ...t, parts }
      })
    else if (type === 'asset')
      patchLast(id, (t) => ({ ...t, assets: [...t.assets, { name: String(ev.name || 'asset'), url: ev.url as string | undefined }] }))
    else if (type === 'file')
      patchLast(id, (t) => ({ ...t, files: [...t.files, { name: String(ev.name || 'file'), size: Number(ev.size || 0) }] }))
    else if (type === 'metrics') patchLast(id, (t) => ({ ...t, metrics: ev as unknown as LaneMetrics, status: 'done' }))
    else if (type === 'done') patchLast(id, (t) => ({ ...t, running: false, status: t.status || 'done' }))
    else if (type === 'error') patchLast(id, (t) => ({ ...t, running: false, error: String(ev.message || 'error') }))
  }

  async function runLane(id: LaneId, q: string, signal: AbortSignal) {
    if (running[id]) return
    setRunning((r) => ({ ...r, [id]: true }))
    setLanes((prev) => ({ ...prev, [id]: [...prev[id], newTurn(q)] }))
    try {
      const resp = await fetch(`/api/compare/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, sessionId: sessionId.current }),
        signal,
      })
      if (!resp.ok || !resp.body) {
        patchLast(id, (t) => ({ ...t, running: false, error: `HTTP ${resp.status}` }))
        return
      }
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            handleEvent(id, JSON.parse(line))
          } catch {
            // ignore partial lines
          }
        }
      }
      patchLast(id, (t) => ({ ...t, running: false }))
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError')
        patchLast(id, (t) => ({ ...t, running: false, error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setRunning((r) => ({ ...r, [id]: false }))
    }
  }

  function ensureAbort(): AbortSignal {
    if (!abortRef.current) abortRef.current = new AbortController()
    return abortRef.current.signal
  }

  function runAll() {
    const q = question.trim()
    if (!q || anyRunning) return
    const signal = ensureAbort()
    LANES.forEach((l) => runLane(l.id, q, signal))
  }

  function runOne(id: LaneId) {
    const q = drafts[id].trim()
    if (!q || running[id]) return
    setDrafts((d) => ({ ...d, [id]: '' }))
    runLane(id, q, ensureAbort())
  }

  async function reset() {
    abortRef.current?.abort()
    abortRef.current = null
    const old = sessionId.current
    sessionId.current = newSessionId()
    setLanes({ modal: [], sandcastle: [], mcp: [], ana: [] })
    setRunning({ modal: false, sandcastle: false, mcp: false, ana: false })
    try {
      await fetch('/api/compare/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: old }),
      })
    } catch {
      // best effort
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-white" style={FONT}>
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">Versus</h1>
          <span className="text-xs text-slate-500">one question → four backends · same Claude harness for A–C · multi-turn</span>
        </div>
        <button onClick={reset} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
          Reset
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden p-2 md:grid-cols-2 xl:grid-cols-4">
        {LANES.map((lane) => {
          const turns = lanes[lane.id]
          const last = turns[turns.length - 1]
          return (
            <div key={lane.id} className="flex min-h-0 flex-col rounded border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{lane.title}</div>
                  <div className="text-[11px] text-slate-500">{lane.sub}</div>
                </div>
                {running[lane.id] && <span className="text-[11px] text-emerald-600">● live</span>}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {turns.length === 0 && <div className="text-xs text-slate-400">Ask a question to start.</div>}
                {turns.map((t, ti) => (
                  <TurnBlock key={ti} turn={t} />
                ))}
              </div>

              <div className="grid grid-cols-3 gap-px border-t bg-slate-200 text-center text-[11px]">
                <Metric
                  label="agent time"
                  value={last?.metrics ? `${(last.metrics.elapsedMs / 1000).toFixed(1)}s` : '—'}
                  sub={last?.metrics && last.metrics.setupMs > 1500 ? `+${(last.metrics.setupMs / 1000).toFixed(0)}s setup` : undefined}
                />
                <Metric
                  label="tokens"
                  value={lane.id === 'ana' ? 'n/a' : last?.metrics ? last.metrics.totalTokens.toLocaleString() : '—'}
                />
                <Metric label="tool calls" value={last?.metrics ? String(last.metrics.toolCalls) : toolCount(last) ? String(toolCount(last)) : '—'} />
              </div>

              <div className="flex gap-1 border-t p-2">
                <input
                  value={drafts[lane.id]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [lane.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && runOne(lane.id)}
                  placeholder={`message ${lane.id}…`}
                  className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-slate-400"
                  style={FONT}
                  disabled={running[lane.id]}
                />
                <button
                  onClick={() => runOne(lane.id)}
                  disabled={running[lane.id] || !drafts[lane.id].trim()}
                  className="rounded bg-slate-800 px-2 py-1 text-[11px] text-white disabled:opacity-40"
                >
                  ▸
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="border-t-2 border-slate-900 bg-slate-50 px-6 py-4 shadow-[0_-6px_16px_rgba(0,0,0,0.05)]">
        <div className="mx-auto max-w-5xl">
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runAll()}
              placeholder="Ask all four the same question…"
              className="flex-1 rounded-md border-2 border-slate-300 bg-white px-4 py-3 text-base shadow-sm outline-none focus:border-slate-900"
              style={FONT}
              autoFocus
              disabled={anyRunning}
            />
            {anyRunning ? (
              <button
                onClick={() => {
                  abortRef.current?.abort()
                  abortRef.current = null
                }}
                className="rounded-md bg-slate-200 px-6 py-3 text-base font-medium text-slate-800"
              >
                Stop
              </button>
            ) : (
              <button onClick={runAll} className="rounded-md bg-slate-900 px-8 py-3 text-base font-semibold text-white shadow-sm hover:bg-slate-800">
                Run all →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TurnBlock({ turn: t }: { turn: Turn }) {
  const images = t.assets.filter((a) => isImageName(a.name) || isImageName(a.url))
  const links = t.assets.filter((a) => !images.includes(a) && a.url)
  return (
    <div className="mb-4 border-b border-slate-100 pb-3 last:border-0">
      <div className="mb-1 text-[11px] font-medium text-slate-500">› {t.q}</div>
      {t.running && <div className="mb-1 text-[10px] text-emerald-600">{t.status || '…'}</div>}

      {t.parts.map((p, i) =>
        p.kind === 'text' ? (
          <pre key={i} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">{p.text}</pre>
        ) : (
          <details key={i} className="my-1 rounded border border-slate-200 bg-slate-50">
            <summary className="cursor-pointer select-none px-2 py-1 text-[11px] text-slate-600">
              <span className={p.ok === false ? 'text-red-600' : p.ok ? 'text-emerald-600' : 'text-slate-400'}>
                {p.ok === false ? '✗' : p.ok ? '✓' : '…'}
              </span>{' '}
              🔧 {p.name}
            </summary>
            {p.code && <pre className="overflow-x-auto border-t border-slate-200 px-2 py-1 text-[10px] text-slate-700">{p.code}</pre>}
            {p.output && (
              <pre className="overflow-x-auto whitespace-pre-wrap border-t border-slate-200 px-2 py-1 text-[10px] text-slate-500">{p.output}</pre>
            )}
          </details>
        )
      )}

      {t.error && <pre className="mt-1 whitespace-pre-wrap text-xs text-red-600">{t.error}</pre>}

      {images.map((a, i) => (
        <figure key={`img-${i}`} className="mt-2">
          <img src={a.url} alt={a.name} className="max-w-full rounded border border-slate-200" />
          <figcaption className="mt-1 text-[10px] text-slate-400">{a.name}</figcaption>
        </figure>
      ))}

      {(t.files.length > 0 || links.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {links.map((a, i) => (
            <a key={`lnk-${i}`} href={a.url} target="_blank" rel="noreferrer" className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-blue-600 underline">
              ↗ {a.name}
            </a>
          ))}
          {t.files.map((f, i) => (
            <span key={`file-${i}`} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-600" title={`${f.size} bytes`}>
              📄 {f.name} · {fmtSize(f.size)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white py-1.5">
      <div className="text-sm font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-[9px] text-amber-600">{sub}</div>}
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  )
}
