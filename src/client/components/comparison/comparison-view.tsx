import { useEffect, useRef, useState } from 'react'
import { SUITE, type Complexity, type BenchmarkQuery } from './benchmark-suite'

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
  | {
      kind: 'tool'
      name: string
      code?: string
      ok?: boolean
      output?: string
    }

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
  {
    id: 'modal',
    title: 'A · Generic sandbox',
    sub: 'Claude Agent SDK (harness) + Modal (DIY)',
    color: '#64748b',
  },
  {
    id: 'sandcastle',
    title: 'B · TextQL Sandcastle',
    sub: 'Claude Agent SDK (harness) + Sandcastle',
    color: '#10b981',
  },
  {
    id: 'mcp',
    title: 'C · Ana via MCP',
    sub: 'Claude Agent SDK (harness) + TextQL MCP → Ana',
    color: '#8b5cf6',
  },
  {
    id: 'ana',
    title: 'D · Ana API',
    sub: 'direct /v2/chats call',
    color: '#f59e0b',
  },
]
const FONT = { fontFamily: "'JetBrains Mono', monospace" } as const
const isImageName = (s?: string) => !!s && /\.(png|jpe?g|gif|webp|svg)$/i.test(s)
// Ana's poll calls are just the harness checking whether Ana has finished — not real
// work. We exclude them from tool-call counts and aggregate metrics, but keep them as
// parts so they still show in each turn's expandable tool details.
const isPollTool = (name: string) => name.endsWith('ana_poll')
const substantiveToolCount = (t?: Turn) =>
  t ? t.parts.filter((p) => p.kind === 'tool' && !isPollTool(p.name)).length : 0

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function newTurn(q: string): Turn {
  return {
    q,
    status: 'starting…',
    parts: [],
    assets: [],
    files: [],
    running: true,
  }
}

const newSessionId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

type RoundMetrics = Partial<Record<LaneId, LaneMetrics>>
// A suite cell holds every repeated run for a lane (runsPerQuery of them), so the
// Insights panel can report a distribution rather than a single noisy sample.
type LaneSamples = Partial<Record<LaneId, LaneMetrics[]>>

export function ComparisonView() {
  const [question, setQuestion] = useState(
    'From the CYBERSYN US real-estate data (Freddie Mac housing timeseries), chart the national house price index over time.',
  )
  const [lanes, setLanes] = useState<Record<LaneId, Turn[]>>({
    modal: [],
    sandcastle: [],
    mcp: [],
    ana: [],
  })
  const [running, setRunning] = useState<Record<LaneId, boolean>>({
    modal: false,
    sandcastle: false,
    mcp: false,
    ana: false,
  })
  const [drafts, setDrafts] = useState<Record<LaneId, string>>({
    modal: '',
    sandcastle: '',
    mcp: '',
    ana: '',
  })
  const [rounds, setRounds] = useState<RoundMetrics[]>([])
  // Per-query, per-lane samples for the most recent suite run, keyed by query id.
  // Each lane accumulates one LaneMetrics per repeated run (see SUITE.runsPerQuery).
  const [suiteResults, setSuiteResults] = useState<Record<string, LaneSamples>>({})
  // Progress of an in-flight suite run (null when no suite is running). `run`/`runs`
  // track the repeated runs of the current query for the "run 3/5" readout.
  const [suiteProgress, setSuiteProgress] = useState<{
    done: number
    total: number
    current: string
    run: number
    runs: number
  } | null>(null)
  const [chartMetric, setChartMetric] = useState<'tools' | 'time'>('tools')
  const [chartFull, setChartFull] = useState(false)
  // Ontology review between rounds (lane B's ./library edits).
  const [ontoFiles, setOntoFiles] = useState<OntoFile[] | null>(null)
  const [ontoLoading, setOntoLoading] = useState(false)
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const reviewedRef = useRef<Set<string>>(new Set())
  const sessionId = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  if (!sessionId.current) sessionId.current = newSessionId()

  const anyRunning = running.modal || running.sandcastle || running.mcp || running.ana
  const busy = anyRunning || !!suiteProgress
  const roundNum = rounds.length
  const hasSuiteResults = Object.keys(suiteResults).length > 0

  useEffect(() => {
    if (!chartFull) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setChartFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chartFull])

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
        if (lastP && lastP.kind === 'text')
          parts[parts.length - 1] = {
            kind: 'text',
            text: lastP.text + String(ev.text || ''),
          }
        else parts.push({ kind: 'text', text: String(ev.text || '') })
        return { ...t, parts }
      })
    else if (type === 'tool')
      patchLast(id, (t) => ({
        ...t,
        status: 'working…',
        parts: [
          ...t.parts,
          {
            kind: 'tool',
            name: String(ev.name || 'tool'),
            code: ev.code as string | undefined,
          },
        ],
      }))
    else if (type === 'tool_result')
      patchLast(id, (t) => {
        const parts = t.parts.slice()
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]
          if (p.kind === 'tool' && p.ok === undefined) {
            parts[i] = {
              ...p,
              ok: Boolean(ev.ok),
              output: ev.output as string | undefined,
            }
            break
          }
        }
        return { ...t, parts }
      })
    else if (type === 'asset')
      patchLast(id, (t) => ({
        ...t,
        assets: [
          ...t.assets,
          {
            name: String(ev.name || 'asset'),
            url: ev.url as string | undefined,
          },
        ],
      }))
    else if (type === 'file')
      patchLast(id, (t) => ({
        ...t,
        files: [...t.files, { name: String(ev.name || 'file'), size: Number(ev.size || 0) }],
      }))
    else if (type === 'metrics')
      patchLast(id, (t) => ({
        ...t,
        metrics: ev as unknown as LaneMetrics,
        status: 'done',
      }))
    else if (type === 'done')
      patchLast(id, (t) => ({
        ...t,
        running: false,
        status: t.status || 'done',
      }))
    else if (type === 'error')
      patchLast(id, (t) => ({
        ...t,
        running: false,
        error: String(ev.message || 'error'),
      }))
  }

  async function runLane(
    id: LaneId,
    q: string,
    signal: AbortSignal,
    opts?: {
      fresh?: boolean
      reviewOntology?: boolean
      onMetrics?: (m: LaneMetrics) => void
    },
  ) {
    if (running[id]) return
    setRunning((r) => ({ ...r, [id]: true }))
    setLanes((prev) => ({ ...prev, [id]: [...prev[id], newTurn(q)] }))
    let finalMetrics: LaneMetrics | undefined
    let substantiveTools = 0 // tool calls this run, excluding Ana poll checks
    try {
      const resp = await fetch(`/api/compare/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          sessionId: sessionId.current,
          fresh: !!opts?.fresh,
        }),
        signal,
      })
      if (!resp.ok || !resp.body) {
        patchLast(id, (t) => ({
          ...t,
          running: false,
          error: `HTTP ${resp.status}`,
        }))
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
            else if (ev.type === 'tool' && typeof ev.name === 'string' && !isPollTool(ev.name)) substantiveTools++
            handleEvent(id, ev)
          } catch {
            // ignore partial lines
          }
        }
      }
      patchLast(id, (t) => ({ ...t, running: false }))
      // Report the poll-excluded tool count so Insights/flywheel aggregates don't
      // penalize the MCP lane for harness polling. Other metrics pass through.
      if (finalMetrics) opts?.onMetrics?.({ ...finalMetrics, toolCalls: substantiveTools })
      // After lane B's fresh run, surface the ontology it wrote for review. Skipped
      // during a suite run (reviewOntology=false) so it doesn't block between queries.
      if (opts?.reviewOntology && id === 'sandcastle') void fetchOntology()
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError')
        patchLast(id, (t) => ({
          ...t,
          running: false,
          error: e instanceof Error ? e.message : String(e),
        }))
    } finally {
      setRunning((r) => ({ ...r, [id]: false }))
    }
  }

  function ensureAbort(): AbortSignal {
    if (!abortRef.current) abortRef.current = new AbortController()
    return abortRef.current.signal
  }

  // Ad-hoc: every lane runs the single input question as a FRESH conversation on the
  // SAME sandbox, so any speedup comes from accumulated ontology. Feeds the
  // "improvement over rounds" chart. Used by the bottom single-question input.
  function runAdHoc() {
    const q = question.trim()
    if (!q || busy) return
    const round = rounds.length
    setRounds((prev) => [...prev, {}])
    setOntoFiles(null)
    const signal = ensureAbort()
    LANES.forEach((l) =>
      runLane(l.id, q, signal, {
        fresh: true,
        reviewOntology: true,
        onMetrics: (m) =>
          setRounds((prev) => {
            const next = prev.slice()
            while (next.length <= round) next.push({})
            next[round] = { ...next[round], [l.id]: m }
            return next
          }),
      }),
    )
  }

  // Suite: run every benchmark query sequentially. Each query runs SUITE.runsPerQuery
  // times, and each run goes across all four lanes (in parallel) as a FRESH
  // conversation on the SAME sandbox, so lane B's ./library ontology compounds across
  // the suite. Every run appends a LaneMetrics sample into suiteResults, so the
  // Insights view can report a median/min/max/σ distribution per lane per query.
  // Ontology review is skipped between queries so the run is unattended.
  async function runSuite() {
    if (busy) return
    const signal = ensureAbort()
    setSuiteResults({})
    setOntoFiles(null)
    const queries = SUITE.queries
    const runs = Math.max(1, SUITE.runsPerQuery)
    try {
      for (let qi = 0; qi < queries.length; qi++) {
        if (signal.aborted) break
        const query = queries[qi]
        // Repeat the same query N times per lane before moving to the next one.
        for (let run = 0; run < runs; run++) {
          if (signal.aborted) break
          setSuiteProgress({
            done: qi,
            total: queries.length,
            current: query.id,
            run,
            runs,
          })
          await Promise.all(
            LANES.map((l) =>
              runLane(l.id, query.question, signal, {
                fresh: true,
                reviewOntology: false,
                onMetrics: (m) =>
                  setSuiteResults((prev) => {
                    const cell = prev[query.id] ?? {}
                    const prior = cell[l.id] ?? []
                    return {
                      ...prev,
                      [query.id]: { ...cell, [l.id]: [...prior, m] },
                    }
                  }),
              }),
            ),
          )
        }
      }
    } finally {
      setSuiteProgress(null)
    }
  }

  function runOne(id: LaneId) {
    const q = drafts[id].trim()
    if (!q || running[id] || suiteProgress) return
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
    setSuiteResults({})
    setSuiteProgress(null)
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
          {suiteProgress ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              suite {suiteProgress.done + 1}/{suiteProgress.total} · {suiteProgress.current} · run{' '}
              {suiteProgress.run + 1}/{suiteProgress.runs}
            </span>
          ) : (
            <button
              onClick={runSuite}
              disabled={busy}
              className="rounded-md bg-emerald-600 px-3.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
              title={`Run all ${SUITE.queries.length} benchmark queries across every lane`}
            >
              Run suite ({SUITE.queries.length}) →
            </button>
          )}
          {roundNum > 0 && <span className="text-xs font-medium text-slate-600">round {roundNum}</span>}
          {(roundNum > 0 || hasSuiteResults) && (
            <button
              onClick={() => setChartFull(true)}
              className="rounded-md bg-slate-900 px-3.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
            >
              Insights
            </button>
          )}
          <button
            onClick={reset}
            className="rounded border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
          >
            Reset
          </button>
        </div>
      </div>

      {chartFull && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white" style={FONT}>
          <div className="flex items-center justify-between border-b px-6 py-3">
            <div className="flex items-baseline gap-3">
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">Insights</h2>
              {hasSuiteResults && (
                <span className="text-xs text-slate-500">{SUITE.name} · per-query winners and aggregate scores</span>
              )}
            </div>
            <button
              onClick={() => setChartFull(false)}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700"
            >
              ✕ close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {hasSuiteResults ? (
              <>
                <SuiteInsights results={suiteResults} />
                {roundNum > 0 && (
                  <FlywheelChart
                    rounds={rounds}
                    metric={chartMetric}
                    onMetric={setChartMetric}
                    expanded={false}
                    canExpand={false}
                    onToggleExpand={() => {}}
                  />
                )}
              </>
            ) : roundNum > 0 ? (
              <div className="h-full">
                <FlywheelChart
                  rounds={rounds}
                  metric={chartMetric}
                  onMetric={setChartMetric}
                  expanded
                  onToggleExpand={() => setChartFull(false)}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden p-2 md:grid-cols-2 xl:grid-cols-4">
        {LANES.map((lane) => {
          const turns = lanes[lane.id]
          const last = turns[turns.length - 1]
          return (
            <div
              key={lane.id}
              className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm"
            >
              <div className="flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: lane.color }} />
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{lane.title}</div>
                    <div className="text-[11px] text-slate-500">{lane.sub}</div>
                  </div>
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
                  sub={
                    last?.metrics && last.metrics.setupMs > 1500
                      ? `+${(last.metrics.setupMs / 1000).toFixed(0)}s setup`
                      : undefined
                  }
                />
                <Metric
                  label="tokens"
                  value={lane.id === 'ana' ? 'n/a' : last?.metrics ? last.metrics.totalTokens.toLocaleString() : '—'}
                />
                <Metric
                  label="tool calls"
                  value={last?.metrics || substantiveToolCount(last) ? String(substantiveToolCount(last)) : '—'}
                />
              </div>

              <div className="flex gap-1 border-t p-2">
                <input
                  value={drafts[lane.id]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [lane.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && runOne(lane.id)}
                  placeholder={`follow-up to ${lane.id}…`}
                  className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[11px] outline-none focus:border-slate-400 disabled:opacity-60"
                  style={FONT}
                  disabled={running[lane.id] || !!suiteProgress}
                />
                <button
                  onClick={() => runOne(lane.id)}
                  disabled={running[lane.id] || !!suiteProgress || !drafts[lane.id].trim()}
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
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Queries</span>
            {suiteProgress && (
              <span className="text-[11px] text-emerald-700">
                running suite {suiteProgress.done + 1}/{suiteProgress.total} · run {suiteProgress.run + 1}/
                {suiteProgress.runs}…
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runAdHoc()}
              placeholder="Ask all four the same question…"
              className="flex-1 rounded-md border-2 border-slate-300 bg-white px-4 py-3 text-base shadow-sm outline-none focus:border-slate-900 disabled:opacity-60"
              style={FONT}
              autoFocus
              disabled={busy}
            />
            {busy ? (
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
                onClick={runAdHoc}
                className="rounded-md bg-slate-900 px-8 py-3 text-base font-semibold text-white shadow-sm hover:bg-slate-800"
              >
                Ask all four →
              </button>
            )}
          </div>
          {roundNum > 0 && !busy && (
            <div className="mt-2 text-center text-[11px] text-slate-500">
              Review &amp; accept the ontology B wrote, then ask again to watch its curve bend down — or run the full
              suite above.
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
  expanded,
  onToggleExpand,
  canExpand = true,
}: {
  rounds: RoundMetrics[]
  metric: 'tools' | 'time'
  onMetric: (m: 'tools' | 'time') => void
  expanded: boolean
  onToggleExpand: () => void
  canExpand?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 900, h: expanded ? 600 : 168 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r)
        setDims({
          w: Math.max(160, Math.round(r.width)),
          h: Math.max(120, Math.round(r.height)),
        })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W = dims.w
  const H = dims.h
  const fz = expanded ? 1.5 : 1 // font / stroke scale
  const padL = expanded ? 60 : 44
  const padR = expanded ? 88 : 56
  const padT = expanded ? 24 : 14
  const padB = expanded ? 40 : 26
  const plotW = Math.max(40, W - padL - padR)
  const plotH = Math.max(40, H - padT - padB)
  const n = rounds.length
  const valOf = (m?: LaneMetrics) =>
    m ? (metric === 'tools' ? m.toolCalls : Math.round(m.elapsedMs / 100) / 10) : null
  let yMax = 1
  for (const r of rounds)
    for (const l of LANES) {
      const v = valOf(r[l.id])
      if (v != null && v > yMax) yMax = v
    }
  yMax = niceMax(yMax)
  const xFor = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const yFor = (v: number) => padT + plotH - (v / yMax) * plotH
  const fmtY = (v: number) => (metric === 'time' ? `${v}` : `${Math.round(v)}`)

  return (
    <div
      className={
        expanded
          ? 'flex h-full flex-col bg-gradient-to-b from-slate-50 to-white px-8 pb-6 pt-5'
          : 'border-b bg-gradient-to-b from-slate-50 to-white px-6 pb-3 pt-3'
      }
    >
      <div className={`flex items-center justify-between ${expanded ? 'mb-4' : 'mb-2'}`}>
        <div className="flex items-baseline gap-2">
          <span className={`font-semibold tracking-tight text-slate-800 ${expanded ? 'text-xl' : 'text-xs'}`}>
            Improvement over rounds
          </span>
          <span className={`text-slate-400 ${expanded ? 'text-sm' : 'text-[11px]'}`}>
            {metric === 'tools' ? 'tool calls' : 'agent seconds'} per round · lower is better
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-md bg-slate-100 p-0.5">
            {(['tools', 'time'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onMetric(m)}
                className={`rounded font-medium transition ${expanded ? 'px-3.5 py-1.5 text-xs' : 'px-2.5 py-1 text-[10px]'} ${
                  metric === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {m === 'tools' ? 'tool calls' : 'time'}
              </button>
            ))}
          </div>
          {(expanded || canExpand) && (
            <button
              onClick={onToggleExpand}
              title={expanded ? 'Collapse (Esc)' : 'Expand to full screen'}
              className={`rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700 ${
                expanded ? 'px-3 py-1.5 text-sm' : 'px-2 py-1 text-[11px]'
              }`}
            >
              {expanded ? '✕ close' : '⤢ expand'}
            </button>
          )}
        </div>
      </div>
      <div
        ref={wrapRef}
        className={expanded ? 'min-h-0 w-full flex-1' : 'w-full'}
        style={expanded ? undefined : { height: 168 }}
      >
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
              <line
                x1={padL}
                y1={padT + plotH * f}
                x2={W - padR}
                y2={padT + plotH * f}
                stroke="#eef2f6"
                strokeWidth={1}
              />
              <text x={padL - 8} y={padT + plotH * f + 3 * fz} textAnchor="end" fontSize={10 * fz} fill="#94a3b8">
                {fmtY(yMax * (1 - f))}
              </text>
            </g>
          ))}
          {/* x labels */}
          {rounds.map((_, i) => (
            <text key={i} x={xFor(i)} y={H - 10 * fz} textAnchor="middle" fontSize={10 * fz} fill="#94a3b8">
              R{i + 1}
            </text>
          ))}
          {/* lane lines (draw B last so it sits on top) */}
          {[...LANES]
            .sort((a, b) => (a.id === 'sandcastle' ? 1 : 0) - (b.id === 'sandcastle' ? 1 : 0))
            .map((lane) => {
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
                  <path
                    d={d}
                    fill="none"
                    stroke={lane.color}
                    strokeWidth={(isHero ? 3 : 1.75) * fz}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity={isHero ? 1 : 0.85}
                  />
                  {pts.map((p, i) => (
                    <circle
                      key={i}
                      cx={p[0]}
                      cy={p[1]}
                      r={(isHero ? 4 : 3) * fz}
                      fill="#fff"
                      stroke={lane.color}
                      strokeWidth={(isHero ? 3 : 2) * fz}
                    />
                  ))}
                  <text
                    x={last[0] + 8 * fz}
                    y={last[1] + 3.5 * fz}
                    fontSize={11 * fz}
                    fontWeight={isHero ? 700 : 500}
                    fill={lane.color}
                  >
                    {fmtY(last[2])}
                  </text>
                </g>
              )
            })}
        </svg>
      </div>
      <div className={`flex flex-wrap gap-x-4 gap-y-1 ${expanded ? 'mt-3' : 'mt-1'}`}>
        {LANES.map((l) => (
          <span
            key={l.id}
            className={`flex items-center gap-1.5 text-slate-500 ${expanded ? 'text-sm' : 'text-[10px]'}`}
          >
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
            <button
              onClick={onApply}
              className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
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
                  rej
                    ? 'border-red-200 bg-red-50 text-red-400 line-through'
                    : 'border-emerald-300 bg-white text-emerald-800'
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
          <pre key={i} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
            {p.text}
          </pre>
        ) : (
          <details key={i} className="my-1 rounded border border-slate-200 bg-slate-50">
            <summary className="cursor-pointer select-none px-2 py-1 text-[11px] text-slate-600">
              <span className={p.ok === false ? 'text-red-600' : p.ok ? 'text-emerald-600' : 'text-slate-400'}>
                {p.ok === false ? '✗' : p.ok ? '✓' : '…'}
              </span>{' '}
              🔧 {p.name}
            </summary>
            {p.code && (
              <pre className="overflow-x-auto border-t border-slate-200 px-2 py-1 text-[10px] text-slate-700">
                {p.code}
              </pre>
            )}
            {p.output && (
              <pre className="overflow-x-auto whitespace-pre-wrap border-t border-slate-200 px-2 py-1 text-[10px] text-slate-500">
                {p.output}
              </pre>
            )}
          </details>
        ),
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
            <a
              key={`lnk-${i}`}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-blue-600 underline"
            >
              ↗ {a.name}
            </a>
          ))}
          {t.files.map((f, i) => (
            <span
              key={`file-${i}`}
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] text-slate-600"
              title={`${f.size} bytes`}
            >
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

// ── Suite aggregate insights ────────────────────────────────────────────────
// Lower is better for every metric. Tool calls and tokens exclude lane D (direct
// API) since it has no agent loop — comparing them to the harness lanes is moot.
// Each query is run SUITE.runsPerQuery times per lane, so every cell is a
// distribution: we report the median (used to pick winners), min, max, and σ, and
// flag whether the best lane's range is disjoint from the runner-up's.

type SuiteMetricKey = 'toolCalls' | 'elapsedMs' | 'totalTokens'

// Time leads — it's the most honest metric here: it captures real cost regardless
// of polling artifacts or how an approach splits work into tool calls.
const SUITE_METRICS: {
  key: SuiteMetricKey
  label: string
  skip?: (id: LaneId) => boolean
}[] = [
  { key: 'elapsedMs', label: 'time' },
  { key: 'toolCalls', label: 'tool calls', skip: (id) => id === 'ana' },
  { key: 'totalTokens', label: 'tokens', skip: (id) => id === 'ana' },
]

const COMPLEXITY_ORDER: Complexity[] = ['simple', 'moderate', 'complex']
const COMPLEXITY_BADGE: Record<Complexity, string> = {
  simple: 'bg-sky-100 text-sky-700',
  moderate: 'bg-amber-100 text-amber-700',
  complex: 'bg-rose-100 text-rose-700',
}

const laneShort = (id: LaneId) => LANES.find((l) => l.id === id)?.title.split(' · ')[0] ?? id

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

// Distribution over a lane's repeated runs for one metric.
interface Stats {
  n: number
  median: number
  min: number
  max: number
  sd: number // population standard deviation
}

function computeStats(xs: number[]): Stats | null {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
  return { n: xs.length, median, min: sorted[0], max: sorted[sorted.length - 1], sd }
}

// The finite values a lane reported for a metric across its repeated runs.
function laneSampleVals(ls: LaneSamples | undefined, id: LaneId, key: SuiteMetricKey): number[] {
  const arr = ls?.[id]
  if (!Array.isArray(arr)) return []
  return arr.map((m) => m[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

const laneStat = (ls: LaneSamples | undefined, id: LaneId, key: SuiteMetricKey): Stats | null =>
  computeStats(laneSampleVals(ls, id, key))

// Lanes tied for the lowest MEDIAN on a metric (lower is better).
function metricWinners(ls: LaneSamples | undefined, key: SuiteMetricKey, skip?: (id: LaneId) => boolean): Set<LaneId> {
  const w = new Set<LaneId>()
  let min = Infinity
  const vals: Array<[LaneId, number]> = []
  for (const l of LANES) {
    if (skip?.(l.id)) continue
    const st = laneStat(ls, l.id, key)
    if (!st) continue
    vals.push([l.id, st.median])
    if (st.median < min) min = st.median
  }
  for (const [id, v] of vals) if (v === min) w.add(id)
  return w
}

// Eyeball check on whether the top two lanes' raw [min,max] ranges overlap. This is
// deliberately NOT framed as statistical significance: with only a handful of runs it
// is sensitive to a single outlier and to sample size, so we report the raw fact
// ("ranges disjoint" / "ranges overlap") plus the smaller of the two sample sizes,
// and let the reader judge. `minN` lets the badge flag thin evidence (n < 2).
type Confidence = {
  disjoint: boolean
  best: LaneId
  second: LaneId
  minN: number
} | null

function metricConfidence(
  ls: LaneSamples | undefined,
  key: SuiteMetricKey,
  skip?: (id: LaneId) => boolean,
): Confidence {
  const ranked: Array<{ id: LaneId; st: Stats }> = []
  for (const l of LANES) {
    if (skip?.(l.id)) continue
    const st = laneStat(ls, l.id, key)
    if (st) ranked.push({ id: l.id, st })
  }
  if (ranked.length < 2) return null
  ranked.sort((a, b) => a.st.median - b.st.median)
  const [best, second] = ranked
  const disjoint = best.st.max < second.st.min || second.st.max < best.st.min
  return {
    disjoint,
    best: best.id,
    second: second.id,
    minN: Math.min(best.st.n, second.st.n),
  }
}

// Mean of the per-query medians for a lane across a set of queries — used for the
// per-complexity ontology-advantage readout.
const laneTierMedian = (rs: Record<string, LaneSamples>, ids: string[], lane: LaneId, key: SuiteMetricKey) =>
  mean(ids.map((id) => laneStat(rs[id], lane, key)?.median ?? null).filter((v): v is number => v != null))

const fmtNum = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const fmtSecs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

function SuiteInsights({ results }: { results: Record<string, LaneSamples> }) {
  const answered = SUITE.queries.filter((q) => results[q.id])

  // Aggregate: credit every lane tied for the lowest median on a metric. Counting
  // only undisputed single-lane wins (the old `w.size === 1`) silently dropped every
  // metric where two lanes shared the lowest median — common with small integer
  // tool-call medians — so clear leaders showed 0. Shared-win counting also keeps the
  // table consistent with the per-query highlights, which already mark all leaders.
  const wins: Record<LaneId, Record<SuiteMetricKey, number>> = {
    modal: { toolCalls: 0, elapsedMs: 0, totalTokens: 0 },
    sandcastle: { toolCalls: 0, elapsedMs: 0, totalTokens: 0 },
    mcp: { toolCalls: 0, elapsedMs: 0, totalTokens: 0 },
    ana: { toolCalls: 0, elapsedMs: 0, totalTokens: 0 },
  }
  for (const q of answered) {
    for (const m of SUITE_METRICS) {
      const w = metricWinners(results[q.id], m.key, m.skip)
      for (const id of w) wins[id][m.key] += 1
    }
  }

  return (
    <div className="px-6 py-5">
      <section className="mb-6">
        <h3 className="mb-1 text-sm font-semibold text-slate-800">Aggregate — lowest-median finishes per metric</h3>
        <p className="mb-3 text-[11px] text-slate-500">
          How often each lane had the lowest median (ties counted for every tied lane) across {answered.length} answered{' '}
          {answered.length === 1 ? 'query' : 'queries'} · {SUITE.runsPerQuery} runs per query per lane · lower is better
          · tool calls exclude Ana poll checks; tool calls and tokens exclude the direct-API lane.
        </p>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="px-3 py-2 text-left font-medium">Lane</th>
                {SUITE_METRICS.map((m) => (
                  <th key={m.key} className="px-3 py-2 text-center font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LANES.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                      <span className="font-medium text-slate-800">{l.title}</span>
                    </span>
                  </td>
                  {SUITE_METRICS.map((m) => (
                    <td key={m.key} className="px-3 py-2 text-center">
                      {m.skip?.(l.id) ? (
                        <span className="text-slate-300">n/a</span>
                      ) : (
                        <span className={wins[l.id][m.key] > 0 ? 'font-semibold text-emerald-700' : 'text-slate-500'}>
                          {wins[l.id][m.key]}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {COMPLEXITY_ORDER.filter((c) => answered.some((q) => q.complexity === c)).map((complexity) => {
        const qs = answered.filter((q) => q.complexity === complexity)
        const ids = qs.map((q) => q.id)
        const avgModal = laneTierMedian(results, ids, 'modal', 'toolCalls')
        const avgSand = laneTierMedian(results, ids, 'sandcastle', 'toolCalls')
        const adv = avgModal != null && avgSand != null ? avgModal - avgSand : null
        return (
          <section key={complexity} className="mb-6">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${COMPLEXITY_BADGE[complexity]}`}
              >
                {complexity}
              </span>
              <span className="text-[11px] text-slate-500">
                {qs.length} {qs.length === 1 ? 'query' : 'queries'}
              </span>
              {adv != null && (
                <span className="ml-auto text-[11px] text-slate-500">
                  ontology advantage (A−B median tool calls):{' '}
                  <span className={adv > 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-slate-600'}>
                    {adv > 0 ? '+' : ''}
                    {adv.toFixed(1)}
                  </span>
                </span>
              )}
            </div>
            <div className="space-y-3">
              {qs.map((q) => (
                <QueryStats key={q.id} query={q} ls={results[q.id]} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// One query's distribution table: lanes × {tool calls, time}, each cell showing
// median (winner highlighted) with min–max and σ underneath, plus a per-metric
// significance badge derived from whether the top two lanes' ranges overlap.
function QueryStats({ query, ls }: { query: BenchmarkQuery; ls: LaneSamples }) {
  const toolWin = metricWinners(ls, 'toolCalls', (id) => id === 'ana')
  const timeWin = metricWinners(ls, 'elapsedMs')
  const toolConf = metricConfidence(ls, 'toolCalls', (id) => id === 'ana')
  const timeConf = metricConfidence(ls, 'elapsedMs')
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-2">
        <span className="text-xs font-medium text-slate-800">{query.category}</span>
        <span className="ml-2 text-[11px] text-slate-400">{query.question}</span>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-slate-50 text-slate-500">
            <th className="px-3 py-2 text-left font-medium">Lane</th>
            <th className="px-3 py-2 text-center font-medium">
              tool calls
              <div className="text-[9px] font-normal text-slate-400">median · min–max · σ</div>
            </th>
            <th className="px-3 py-2 text-center font-medium">
              time
              <div className="text-[9px] font-normal text-slate-400">median · min–max · σ</div>
            </th>
          </tr>
        </thead>
        <tbody>
          {LANES.map((l) => {
            const toolStat = l.id === 'ana' ? null : laneStat(ls, l.id, 'toolCalls')
            const timeStat = laneStat(ls, l.id, 'elapsedMs')
            return (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                    <span className="font-medium text-slate-800">{laneShort(l.id)}</span>
                  </span>
                </td>
                {l.id === 'ana' ? (
                  <td className="px-3 py-2 text-center text-slate-300">n/a</td>
                ) : (
                  <StatCell st={toolStat} kind="tools" won={toolWin.has(l.id)} />
                )}
                <StatCell st={timeStat} kind="time" won={timeWin.has(l.id)} />
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 px-3 py-2">
        <ConfidenceBadge metric="tool calls" conf={toolConf} />
        <ConfidenceBadge metric="time" conf={timeConf} />
      </div>
    </div>
  )
}

function StatCell({ st, kind, won }: { st: Stats | null; kind: 'tools' | 'time'; won: boolean }) {
  if (!st) return <td className="px-3 py-2 text-center text-slate-300">·</td>
  const fmt = (v: number) => (kind === 'time' ? fmtSecs(v) : fmtNum(v))
  const median = kind === 'time' ? fmtSecs(st.median) : `${fmtNum(st.median)} tc`
  return (
    <td className={`px-3 py-2 text-center ${won ? 'bg-emerald-50' : ''}`}>
      <div className={won ? 'font-semibold text-emerald-700' : 'text-slate-700'}>{median}</div>
      <div className="text-[10px] text-slate-400">
        {fmt(st.min)}–{fmt(st.max)} · σ {fmt(st.sd)}
      </div>
    </td>
  )
}

function ConfidenceBadge({ metric, conf }: { metric: string; conf: Confidence }) {
  if (!conf) return null
  const { disjoint, best, second, minN } = conf
  const thin = minN < 2 // single-sample range — overlap test is meaningless
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium ${
        disjoint && !thin ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
      }`}
      title={`${laneShort(best)} vs ${laneShort(second)}: min–max ranges ${
        disjoint ? 'do not overlap' : 'overlap'
      } (n=${minN} per lane). Raw range comparison — sensitive to outliers and sample size, not a significance test.`}
    >
      <span className="uppercase tracking-wide">{metric}</span>
      <span>
        {laneShort(best)} vs {laneShort(second)}
      </span>
      <span className="opacity-70">
        · ranges {disjoint ? 'disjoint' : 'overlap'} · n={minN}
      </span>
    </span>
  )
}
