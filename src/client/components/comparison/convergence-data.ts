// Pure data-shaping for the Insights per-run table, convergence chart, and derived
// ratios. comparison-view.tsx imports back from here, so read the imported `LANES`
// only inside functions, never at module-eval time, to keep that cycle benign.
import { LANES, type LaneId, type LaneMetrics, type LaneSamples } from './comparison-view'

// Largest number of repeated-run samples any lane reported. Lanes can be ragged —
// a lane that errored on some runs reports fewer samples — so the per-run table and
// convergence chart size themselves to the longest lane.
export function runCount(ls: LaneSamples | undefined): number {
  let max = 0
  for (const l of LANES) {
    const arr = ls?.[l.id]
    if (Array.isArray(arr) && arr.length > max) max = arr.length
  }
  return max
}

export interface PerRunRow {
  id: LaneId
  runs: (LaneMetrics | undefined)[]
}

// One row per lane (in LANES order), each lane's samples aligned to run indices
// 0 … runCount-1. A run a lane never reported (ragged array) becomes `undefined`.
export function perRunRows(ls: LaneSamples | undefined): PerRunRow[] {
  const n = runCount(ls)
  return LANES.map((l) => {
    const arr = ls?.[l.id]
    const runs: (LaneMetrics | undefined)[] = []
    for (let i = 0; i < n; i++) runs.push(Array.isArray(arr) ? arr[i] : undefined)
    return { id: l.id, runs }
  })
}

export interface ConvergencePoint {
  run: number // 0-based run index
  seconds: number
}
export interface ConvergenceLaneSeries {
  id: LaneId
  points: ConvergencePoint[]
}

// One polyline per lane that reported ≥1 sample: time in seconds at each run it
// reported. Lanes with no samples are omitted entirely (no line to draw).
export function convergenceSeries(ls: LaneSamples | undefined): ConvergenceLaneSeries[] {
  const out: ConvergenceLaneSeries[] = []
  for (const l of LANES) {
    const arr = ls?.[l.id]
    if (!Array.isArray(arr) || arr.length === 0) continue
    const points: ConvergencePoint[] = []
    arr.forEach((m, i) => {
      if (m && Number.isFinite(m.elapsedMs)) points.push({ run: i, seconds: m.elapsedMs / 1000 })
    })
    if (points.length) out.push({ id: l.id, points })
  }
  return out
}

// Bare median: sort ascending; even length averages the two middle values (matches
// computeStats, which the unit tests pin this against).
export function median(nums: number[]): number | null {
  if (!nums.length) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Finite `elapsedMs` values a lane reported across its repeated runs — same shape as
// comparison-view's `laneSampleVals`, narrowed to the one metric these ratios use.
function elapsedVals(ls: LaneSamples | undefined, id: LaneId): number[] {
  const arr = ls?.[id]
  if (!Array.isArray(arr)) return []
  return arr.map((m) => m?.elapsedMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
}

export interface DerivedMetricsResult {
  speedRatioBvsA: number | null
  convergenceB: number | null
  gapBvsD: number | null
}

// Three time-based ratios per query (lower is better for all three). Lane C (`mcp`)
// is intentionally excluded — it appears in none of these formulas. "run 1" / "run N"
// are lane B's first and last ACTUAL samples, not the global run count.
export function derivedMetrics(ls: LaneSamples | undefined): DerivedMetricsResult {
  const aMed = median(elapsedVals(ls, 'modal')) // A
  const dMed = median(elapsedVals(ls, 'ana')) // D
  const bMed = median(elapsedVals(ls, 'sandcastle')) // B

  const bArr = Array.isArray(ls?.sandcastle) ? ls!.sandcastle! : []
  const bFirst = bArr[0]
  const bLast = bArr.length ? bArr[bArr.length - 1] : undefined
  const bLastFinite = bLast && Number.isFinite(bLast.elapsedMs) ? bLast.elapsedMs : null

  // B median / A median — B's typical speed relative to the generic-sandbox lane.
  const speedRatioBvsA = bMed != null && aMed != null && aMed !== 0 ? bMed / aMed : null

  // B run N / B run 1 — how much B's time improved across runs (<1 = got faster).
  // Needs ≥2 B samples and a non-zero, finite first sample.
  const convergenceB =
    bArr.length >= 2 &&
    bFirst &&
    Number.isFinite(bFirst.elapsedMs) &&
    bFirst.elapsedMs !== 0 &&
    bLastFinite != null
      ? bLastFinite / bFirst.elapsedMs
      : null

  // B run N / D median — how close B's converged time is to the direct-API lane.
  const gapBvsD = bLastFinite != null && dMed != null && dMed !== 0 ? bLastFinite / dMed : null

  return { speedRatioBvsA, convergenceB, gapBvsD }
}
