import { describe, expect, it } from 'vitest'
import {
  convergenceSeries,
  derivedMetrics,
  median,
  perRunRows,
  runCount,
} from './convergence-data'
import type { LaneMetrics, LaneSamples } from './comparison-view'

// Minimal LaneMetrics factory — only elapsedMs/toolCalls matter to the helper; the
// rest are filled with zeros so the fixtures stay readable.
const m = (elapsedMs: number, toolCalls = 0): LaneMetrics => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  toolCalls,
  elapsedMs,
  setupMs: 0,
})

describe('runCount', () => {
  it('is the max sample-array length across lanes', () => {
    const ls: LaneSamples = {
      modal: [m(1), m(2), m(3)],
      sandcastle: [m(1), m(2)],
      ana: [m(1)],
    }
    expect(runCount(ls)).toBe(3)
  })

  it('is 0 for empty / undefined samples', () => {
    expect(runCount({})).toBe(0)
    expect(runCount(undefined)).toBe(0)
  })
})

describe('perRunRows', () => {
  it('returns one row per lane in LANES order with equal-length samples aligned', () => {
    const ls: LaneSamples = {
      modal: [m(1000, 5), m(1100, 6)],
      sandcastle: [m(900, 3), m(800, 2)],
      mcp: [m(1200, 7), m(1300, 8)],
      ana: [m(700), m(650)],
    }
    const rows = perRunRows(ls)
    expect(rows.map((r) => r.id)).toEqual(['modal', 'sandcastle', 'mcp', 'ana'])
    rows.forEach((r) => expect(r.runs).toHaveLength(2))
    // correct time + tool calls survive on the row metrics
    expect(rows[0].runs[0]?.elapsedMs).toBe(1000)
    expect(rows[0].runs[0]?.toolCalls).toBe(5)
    expect(rows[1].runs[1]?.elapsedMs).toBe(800)
  })

  it('pads ragged arrays so missing runs become undefined (no crash)', () => {
    const ls: LaneSamples = {
      modal: [m(1), m(2), m(3)],
      sandcastle: [m(9)], // errored after run 1
    }
    const rows = perRunRows(ls)
    rows.forEach((r) => expect(r.runs).toHaveLength(3)) // = runCount
    const sand = rows.find((r) => r.id === 'sandcastle')!
    expect(sand.runs[0]?.elapsedMs).toBe(9)
    expect(sand.runs[1]).toBeUndefined()
    expect(sand.runs[2]).toBeUndefined()
  })

  it('renders a lane absent from LaneSamples as an all-undefined row', () => {
    const ls: LaneSamples = { modal: [m(1), m(2)] }
    const rows = perRunRows(ls)
    const ana = rows.find((r) => r.id === 'ana')!
    expect(ana.runs).toEqual([undefined, undefined])
  })
})

describe('convergenceSeries', () => {
  it('maps elapsedMs to seconds for each lane with samples', () => {
    const ls: LaneSamples = {
      modal: [m(1000), m(2000)],
      sandcastle: [m(500), m(250)],
    }
    const series = convergenceSeries(ls)
    expect(series.map((s) => s.id)).toEqual(['modal', 'sandcastle'])
    expect(series[0].points).toEqual([
      { run: 0, seconds: 1 },
      { run: 1, seconds: 2 },
    ])
    expect(series[1].points).toEqual([
      { run: 0, seconds: 0.5 },
      { run: 1, seconds: 0.25 },
    ])
  })

  it('omits lanes that are entirely absent (no crash)', () => {
    const ls: LaneSamples = { modal: [m(1000)] }
    const series = convergenceSeries(ls)
    expect(series.map((s) => s.id)).toEqual(['modal'])
  })
})

describe('median', () => {
  it('returns the middle value for odd-length input', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for even-length input (not the lower)', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([10, 20])).toBe(15)
  })

  it('sorts unsorted input internally', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('returns null for empty input', () => {
    expect(median([])).toBeNull()
  })
})

describe('derivedMetrics', () => {
  it('computes the three ratios from known A/B/D samples', () => {
    const ls: LaneSamples = {
      modal: [m(2000), m(2000)], // A median 2000
      sandcastle: [m(1000), m(1500), m(500)], // B median 1000, first 1000, last 500
      ana: [m(400), m(600)], // D median 500
    }
    const d = derivedMetrics(ls)
    expect(d.speedRatioBvsA).toBeCloseTo(1000 / 2000) // 0.5
    expect(d.convergenceB).toBeCloseTo(500 / 1000) // 0.5
    expect(d.gapBvsD).toBeCloseTo(500 / 500) // 1.0
  })

  it('nulls speedRatioBvsA when A is absent or its median is 0', () => {
    expect(derivedMetrics({ sandcastle: [m(1000)] }).speedRatioBvsA).toBeNull()
    expect(
      derivedMetrics({ modal: [m(0), m(0)], sandcastle: [m(1000)] }).speedRatioBvsA,
    ).toBeNull()
  })

  it('nulls convergenceB when B has a single run', () => {
    expect(derivedMetrics({ sandcastle: [m(1000)] }).convergenceB).toBeNull()
  })

  it('nulls gapBvsD when D is absent', () => {
    expect(derivedMetrics({ sandcastle: [m(1000), m(800)] }).gapBvsD).toBeNull()
  })

  it('nulls all three when B is absent', () => {
    const d = derivedMetrics({ modal: [m(2000)], ana: [m(500)] })
    expect(d.speedRatioBvsA).toBeNull()
    expect(d.convergenceB).toBeNull()
    expect(d.gapBvsD).toBeNull()
  })

  it('is unaffected by lane C (mcp) being present', () => {
    const base: LaneSamples = {
      modal: [m(2000), m(2000)],
      sandcastle: [m(1000), m(1500), m(500)],
      ana: [m(400), m(600)],
    }
    const withMcp: LaneSamples = { ...base, mcp: [m(99999), m(1)] }
    expect(derivedMetrics(withMcp)).toEqual(derivedMetrics(base))
  })
})
