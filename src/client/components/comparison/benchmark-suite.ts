/**
 * Benchmark query suite for the Versus comparison.
 *
 * A suite is just an ordered list of questions with metadata. The ComparisonView
 * runs every query across all four lanes (see runSuite) and aggregates the results
 * by complexity, so you can see whether the ontology advantage grows with difficulty.
 *
 * To swap in a different suite later, export another `BenchmarkSuite` from here (or a
 * sibling file) and change the `SUITE` import in comparison-view.tsx. Keeping the
 * config in its own module is the whole point — the UI never hardcodes questions.
 */

export type Complexity = 'simple' | 'moderate' | 'complex'

export interface BenchmarkQuery {
  /** Stable id — used as the key for per-query results. */
  id: string
  /** The natural-language question sent to every lane. */
  question: string
  /** Free-form grouping label (e.g. 'trend', 'ranking') for display only. */
  category: string
  complexity: Complexity
}

export interface BenchmarkSuite {
  name: string
  description: string
  /**
   * How many times each query runs per lane before moving on. Repeating lets the
   * Insights panel report a distribution (median/min/max/σ) instead of a single
   * noisy sample, and decide whether a lane's win is significant or within noise.
   */
  runsPerQuery: number
  queries: BenchmarkQuery[]
}

/**
 * CYBERSYN US real-estate suite (Freddie Mac House Price Index timeseries).
 *
 * Intentionally minimal: a single simple query, run multiple times, so we can
 * validate the statistical-consistency harness quickly before scaling up. Grow
 * the benchmark by adding entries at the TODO markers below — the UI is fully
 * data-driven, so the "Run suite (N)" button and the per-complexity aggregation
 * pick up new queries automatically.
 */
export const CYBERSYN_SUITE: BenchmarkSuite = {
  name: 'CYBERSYN US Real Estate',
  description: 'Freddie Mac House Price Index questions at escalating complexity.',
  runsPerQuery: 5,
  queries: [
    {
      id: 'hpi-trend',
      question:
        'From the CYBERSYN US real-estate data (Freddie Mac housing timeseries), chart the national house price index over time.',
      category: 'trend',
      complexity: 'simple',
    },

    // TODO: add moderate queries
    // e.g. state-vs-state comparisons, year-over-year change, top-N rankings —
    // questions that reward an agent that already knows the schema/joins.

    // TODO: add complex queries
    // e.g. recovery-speed-from-2008, largest peak-to-trough drawdown — multi-step
    // analyses where lane B's accumulated ontology should pull furthest ahead.
  ],
}

/** The suite the UI runs. Swap this to point at a different suite. */
export const SUITE: BenchmarkSuite = CYBERSYN_SUITE
