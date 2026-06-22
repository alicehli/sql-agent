import { useEffect, useRef, useState } from 'react'

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

interface OntoFile {
  name: string
  additions?: number
  deletions?: number
  is_new?: boolean
  is_delete?: boolean
  is_rename?: boolean
}

const LANES: { id: LaneId; title: string; sub: string; color: string }[] = [
  { id: 'modal', title: 'A · Generic sandbox', sub: 'Claude Agent SDK (harness) + Modal (DIY)', color: '#64748b' },
  { id: 'sandcastle', title: 'B · TextQL Sandcastle', sub: 'Claude Agent SDK (harness) + Sandcastle', color: '#10b981' },
  { id: 'mcp', title: 'C · Ana via MCP', sub: 'Claude Agent SDK (harness) + TextQL MCP → Ana', color: '#8b5cf6' },
  { id: 'ana', title: 'D · Ana API', sub: 'direct /v2/chats call', color: '#f59e0b' },
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

type RoundMetrics = Partial<Record<LaneId, LaneMetrics>>

export function ComparisonView() {
  const [question, setQuestion] = useState(
    'From the CYBERSYN US real-estate data (Freddie Mac housing timeseries), chart the national house price index over time.'
  )
  const [lanes, setLanes] = useState<Record<LaneId, Turn[]>>({ modal: [], sandcastle: [], mcp: [], ana: [] })
  const [running, setRunning] = useState<Record<LaneId, boolean>>({ modal: false, sandcastle: false, mcp: false, ana: false })
  const [drafts, setDrafts] = useState<Record<LaneId, string>>({ modal: '', sandcastle: '', mcp: '', ana: '' })
  const [rounds, setRounds] = useState<RoundMetrics[]>([])
  const [chartMetric, setChartMetric] = useState<'tools' | 'time'>('tools')
  // Ontology review between rounds (lane B's ./library edits).
  const [ontoFiles, setOntoFiles] = useState<OntoFile[] | null>(null)
  const [ontoLoading, setOntoLoading] = useState(false)
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const reviewedRef = useRef<Set<string>>(new Set())
  const sessionId = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  if (!sessionId.current) sessionId.current = newSessionId()

  const anyRunning = running.modal || running.sandcastle || running.mcp || running.ana
  const roundNum = rounds.length

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

  async function runLane(id: LaneId, q: string, signal: AbortSignal, opts?: { fresh?: boolean; round?: number }) {
    if (running[id]) return
    setRunning((r) => ({ ...r, [id]: true }))
    setLanes((prev) => ({ ...prev, [id]: [...prev[id], newTurn(q)] }))
    let finalMetrics: LaneMetrics | undefined
    try {
      const resp = await fetch(`/api/compare/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, sessionId: sessionId.current, fresh: !!opts?.fresh }),
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
            const ev = JSON.parse(line)
            if (ev.type === 'metrics') finalMetrics = ev as LaneMetrics
            handleEvent(id, ev)
          } catch {
            // ignore partial lines
          }
        }
      }
      patchLast(id, (t) => ({ ...t, running: false }))
      if (opts?.round !== undefined && finalMetrics) {
        const m = finalMetrics
        const r = opts.round
        setRounds((prev) => {
          const next = prev.slice()
          while (next.length <= r) next.push({})
          next[r] = { ...next[r], [id]: m }
          return next
        })
      }
      // After lane B's fresh round, surface the ontology it wrote for review.
      if (opts?.fresh && id === 'sandcastle') void fetchOntology()
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

  // A flywheel round: every lane runs the same question as a FRESH conversation
  // on the SAME sandbox, so any speedup comes from accumulated ontology.
  function runRound() {
    const q = question.trim()
    if (!q || anyRunning) return
    const round = rounds.length
    setRounds((prev) => [...prev, {}])
    setOntoFiles(null)
    const signal = ensureAbort()
    LANES.forEach((l) => runLane(l.id, q, signal, { fresh: true, round }))
  }

  function runOne(id: LaneId) {
    const q = drafts[id].trim()
    if (!q || running[id]) return
    setDrafts((d) => ({ ...d, [id]: '' }))
    runLane(id, q, ensureAbort())
  }

  async function fetchOntology() {
    setOntoLoading(true)
    try {
      const r = await fetch(`/api/compare/ontology?sessionId=${encodeURIComponent(sessionId.current)}`)
      if (!r.ok) return
      const data = (await r.json()) as { files?: OntoFile[] }
      const fresh = (data.files || []).filter((f) => !reviewedRef.current.has(f.name))
      setOntoFiles(fresh.length ? fresh : null)
      setRejected(new Set())
    } catch {
      // best effort
    } finally {
      setOntoLoading(false)
    }
  }

  async function applyDecision() {
    const files = ontoFiles || []
    const reject = files.filter((f) => rejected.has(f.name)).map((f) => f.name)
    files.forEach((f) => reviewedRef.current.add(f.name))
    setOntoFiles(null)
    try {
      await fetch('/api/compare/ontology/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId.current, reject }),
      })
    } catch {
      // best effort
    }
  }

  async function reset() {
    abortRef.current?.abort()
    abortRef.current = null
    const old = sessionId.current
    sessionId.current = newSessionId()
    reviewedRef.current = new Set()
    setLanes({ modal: [], sandcastle: [], mcp: [], ana: [] })
    setRunning({ modal: false, sandcastle: false, mcp: false, ana: false })
    setRounds([])
    setOntoFiles(null)
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
          <span className="text-xs text-slate-500">
            same question, every round · fresh conversation, same sandbox · ontology compounds → fewer tool calls
          </span>
        </div>
        <div className="flex items-center gap-3">
          {roundNum > 0 && <span className="text-xs font-medium text-slate-600">round {roundNum}</span>}
          <button onClick={reset} className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">
            Reset
          </button>
        </div>
      </div>

      {rounds.length > 0 && (
        <FlywheelChart rounds={rounds} metric={chartMetric} onMetric={setChartMetric} />
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden p-2 md:grid-cols-2 xl:grid-cols-4">
        {LANES.map((lane) => {
          const turns = lanes[lane.id]
          const last = turns[turns.length - 1]
          return (
            <div key={lane.id} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="h-1 w-full" style={{ backgroundColor: lane.color }} />
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900">{lane.title}</div>
                  <div className="text-[11px] text-slate-500">{lane.sub}</div>
                </div>
                {running[lane.id] && (
                  <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> live
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {turns.length === 0 && <div className="text-xs text-slate-400">Run a round to start.</div>}
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
                  placeholder={`follow-up to ${lane.id}…`}
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

      {(ontoFiles || ontoLoading) && (
        <OntologyReview
          files={ontoFiles}
          loading={ontoLoading}
          rejected={rejected}
          onToggle={(name) =>
            setRejected((prev) => {
              const next = new Set(prev)
              if (next.has(name)) next.delete(name)
              else next.add(name)
              return next
            })
          }
          onApply={applyDecision}
        />
      )}

      <div className="border-t-2 border-slate-900 bg-slate-50 px-6 py-4 shadow-[0_-6px_16px_rgba(0,0,0,0.05)]">
        <div className="mx-auto max-w-5xl">
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runRound()}
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
              <button
                onClick={runRound}
                className="rounded-md bg-slate-900 px-8 py-3 text-base font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                Run round {roundNum + 1} →
              </button>
            )}
          </div>
          {roundNum > 0 && !anyRunning && (
            <div className="mt-2 text-center text-[11px] text-slate-500">
              Review &amp; accept the ontology B wrote, then run the next round to watch its curve bend down.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FlywheelChart({
  rounds,
  metric,
  onMetric,
}: {
  rounds: RoundMetrics[]
  metric: 'tools' | 'time'
  onMetric: (m: 'tools' | 'time') => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(900)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width
      if (cw && cw > 100) setW(Math.round(cw))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = 168
  const padL = 44
  const padR = 56
  const padT = 14
  const padB = 26
  const plotW = Math.max(40, W - padL - padR)
  const plotH = H - padT - padB
  const n = rounds.length
  const valOf = (m?: LaneMetrics) => (m ? (metric === 'tools' ? m.toolCalls : Math.round(m.elapsedMs / 100) / 10) : null)
  let yMax = 1
  for (const r of rounds) for (const l of LANES) {
    const v = valOf(r[l.id])
    if (v != null && v > yMax) yMax = v
  }
  yMax = niceMax(yMax)
  const xFor = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const yFor = (v: number) => padT + plotH - (v / yMax) * plotH
  const fmtY = (v: number) => (metric === 'time' ? `${v}` : `${Math.round(v)}`)

  return (
    <div className="border-b bg-gradient-to-b from-slate-50 to-white px-6 pb-3 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold tracking-tight text-slate-800">Improvement over rounds</span>
          <span className="text-[11px] text-slate-400">{metric === 'tools' ? 'tool calls' : 'agent seconds'} per round · lower is better</span>
        </div>
        <div className="flex gap-1 rounded-md bg-slate-100 p-0.5">
          {(['tools', 'time'] as const).map((m) => (
            <button
              key={m}
              onClick={() => onMetric(m)}
              className={`rounded px-2.5 py-1 text-[10px] font-medium transition ${
                metric === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {m === 'tools' ? 'tool calls' : 'time'}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="w-full">
        <svg width={W} height={H} className="block">
          <defs>
            <linearGradient id="bFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.16} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          {/* y gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={padL} y1={padT + plotH * f} x2={W - padR} y2={padT + plotH * f} stroke="#eef2f6" strokeWidth={1} />
              <text x={padL - 8} y={padT + plotH * f + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
                {fmtY(yMax * (1 - f))}
              </text>
            </g>
          ))}
          {/* x labels */}
          {rounds.map((_, i) => (
            <text key={i} x={xFor(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#94a3b8">
              R{i + 1}
            </text>
          ))}
          {/* lane lines (draw B last so it sits on top) */}
          {[...LANES].sort((a, b) => (a.id === 'sandcastle' ? 1 : 0) - (b.id === 'sandcastle' ? 1 : 0)).map((lane) => {
            const isHero = lane.id === 'sandcastle'
            const pts: Array<[number, number, number]> = []
            rounds.forEach((r, i) => {
              const v = valOf(r[lane.id])
              if (v != null) pts.push([xFor(i), yFor(v), v])
            })
            if (pts.length === 0) return null
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
            const last = pts[pts.length - 1]
            return (
              <g key={lane.id}>
                {isHero && pts.length > 1 && (
                  <path
                    d={`${d} L${last[0].toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0][0].toFixed(1)},${(padT + plotH).toFixed(1)} Z`}
                    fill="url(#bFill)"
                  />
                )}
                <path d={d} fill="none" stroke={lane.color} strokeWidth={isHero ? 3 : 1.75} strokeLinejoin="round" strokeLinecap="round" opacity={isHero ? 1 : 0.85} />
                {pts.map((p, i) => (
                  <circle key={i} cx={p[0]} cy={p[1]} r={isHero ? 4 : 3} fill="#fff" stroke={lane.color} strokeWidth={isHero ? 3 : 2} />
                ))}
                <text x={last[0] + 8} y={last[1] + 3.5} fontSize={11} fontWeight={isHero ? 700 : 500} fill={lane.color}>
                  {fmtY(last[2])}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {LANES.map((l) => (
          <span key={l.id} className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <span className="inline-block h-1.5 w-4 rounded-full" style={{ backgroundColor: l.color }} /> {l.title}
          </span>
        ))}
      </div>
    </div>
  )
}

function niceMax(v: number): number {
  if (v <= 1) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

function OntologyReview({
  files,
  loading,
  rejected,
  onToggle,
  onApply,
}: {
  files: OntoFile[] | null
  loading: boolean
  rejected: Set<string>
  onToggle: (name: string) => void
  onApply: () => void
}) {
  return (
    <div className="border-t-2 border-emerald-500 bg-emerald-50 px-6 py-3">
      <div className="mx-auto max-w-5xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold text-emerald-800">
            🧠 Ontology written by lane B this round — accept to compound, reject to discard
          </div>
          {files && (
            <button onClick={onApply} className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
              Apply ({files.filter((f) => !rejected.has(f.name)).length} kept) →
            </button>
          )}
        </div>
        {loading && <div className="text-[11px] text-emerald-700">checking ./library…</div>}
        {files && files.length === 0 && <div className="text-[11px] text-emerald-700">No new ontology this round.</div>}
        <div className="flex flex-wrap gap-2">
          {(files || []).map((f) => {
            const rej = rejected.has(f.name)
            return (
              <button
                key={f.name}
                onClick={() => onToggle(f.name)}
                className={`flex items-center gap-2 rounded border px-3 py-1.5 text-[11px] ${
                  rej ? 'border-red-200 bg-red-50 text-red-400 line-through' : 'border-emerald-300 bg-white text-emerald-800'
                }`}
                title={rej ? 'will be discarded' : 'will be kept for next round'}
              >
                <span>{rej ? '✗' : '✓'}</span>
                <span className="font-medium">{f.name}</span>
                {f.is_new && <span className="rounded bg-emerald-100 px-1 text-[9px] text-emerald-600">new</span>}
                {typeof f.additions === 'number' && <span className="text-[9px] text-slate-400">+{f.additions}</span>}
              </button>
            )
          })}
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

      {t.error && (
        <div className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
          {/load failed|networkerror|fetch|terminated/i.test(t.error)
            ? '⚠ connection dropped mid-stream — re-run this round'
            : `⚠ ${t.error}`}
        </div>
      )}

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
