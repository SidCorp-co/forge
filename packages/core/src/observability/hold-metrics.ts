/**
 * ISS-198 — hold lifecycle counters surfaced for Prometheus / Grafana.
 * ISS-228 — extended with `dispatch_barrier_skips_total{reason}` so the
 * pg-boss-path barrier ({@link assertDispatchable}) reports a per-reason
 * skip counter the same way the picker does.
 *
 * We don't pull in a full prom-client wiring here (no metrics endpoint yet);
 * instead we maintain in-process counters that can be scraped via the
 * existing admin/health surface. Once a metrics endpoint lands in core the
 * `getHoldMetricsSnapshot` shape is what gets serialized.
 *
 * Metrics:
 *   - forge_hold_set_total{kind, indefinite}: incremented every time
 *     `setManualHoldBlock` writes manual_hold=true.
 *   - forge_hold_auto_clear_total{kind}: incremented for each row the
 *     sweeper auto-clears.
 *   - forge_runner_death_detection_seconds histogram: observed when the
 *     dispatcher's L5 gate refuses a stale runner; value is `now - lastSeen`.
 *   - dispatch_barrier_skips_total{reason}: incremented every time
 *     `handleDispatch` / `handlePmDispatch` leaves a job queued because
 *     `assertDispatchable` reported a failing gate (ISS-228 cascade fix).
 *
 * The histogram is a simple bucket list — replace with prom-client once a
 * `/metrics` endpoint exists.
 */

import type { GateSkipReason } from '../jobs/dispatch-gates.js';

type HoldKind = 'transient_network' | 'permanent_invalid' | 'unknown';

interface HoldSetCounters {
  kind: HoldKind;
  indefinite: boolean;
  count: number;
}

interface HoldClearCounters {
  kind: HoldKind | 'unknown_no_context';
  count: number;
}

const RUNNER_DEATH_BUCKETS_SECONDS = [10, 20, 30, 45, 60, 90, 120, 300] as const;

interface RunnerDeathHistogram {
  bucketsLeq: Map<number, number>;
  count: number;
  sumSeconds: number;
}

interface DispatchBarrierCounters {
  reason: GateSkipReason;
  count: number;
}

interface HoldMetricsState {
  holdSet: Map<string, HoldSetCounters>;
  holdAutoClear: Map<string, HoldClearCounters>;
  runnerDeath: RunnerDeathHistogram;
  dispatchBarrierSkips: Map<GateSkipReason, DispatchBarrierCounters>;
}

function makeState(): HoldMetricsState {
  const histogram: RunnerDeathHistogram = {
    bucketsLeq: new Map(),
    count: 0,
    sumSeconds: 0,
  };
  for (const b of RUNNER_DEATH_BUCKETS_SECONDS) histogram.bucketsLeq.set(b, 0);
  return {
    holdSet: new Map(),
    holdAutoClear: new Map(),
    runnerDeath: histogram,
    dispatchBarrierSkips: new Map(),
  };
}

let state: HoldMetricsState = makeState();

export function recordHoldSet(input: { kind: HoldKind; indefinite: boolean }): void {
  const key = `${input.kind}|${input.indefinite ? '1' : '0'}`;
  const existing = state.holdSet.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    state.holdSet.set(key, { kind: input.kind, indefinite: input.indefinite, count: 1 });
  }
}

export function recordHoldAutoClear(input: { kind: HoldKind | 'unknown_no_context' }): void {
  const existing = state.holdAutoClear.get(input.kind);
  if (existing) {
    existing.count += 1;
  } else {
    state.holdAutoClear.set(input.kind, { kind: input.kind, count: 1 });
  }
}

/**
 * ISS-228 — increment `dispatch_barrier_skips_total{reason}` every time
 * the pg-boss path leaves a job queued because `assertDispatchable`
 * reported a failing gate. Operators watch the `project_cap` series to
 * detect cascade attempts (5+ skips in 90s while `manualHold` is being
 * cleared en masse, ISS-228 forge-dev incident).
 */
export function recordDispatchBarrierSkip(reason: GateSkipReason): void {
  const existing = state.dispatchBarrierSkips.get(reason);
  if (existing) {
    existing.count += 1;
  } else {
    state.dispatchBarrierSkips.set(reason, { reason, count: 1 });
  }
}

export function recordRunnerDeathDetection(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  state.runnerDeath.count += 1;
  state.runnerDeath.sumSeconds += seconds;
  for (const bucket of RUNNER_DEATH_BUCKETS_SECONDS) {
    if (seconds <= bucket) {
      state.runnerDeath.bucketsLeq.set(bucket, (state.runnerDeath.bucketsLeq.get(bucket) ?? 0) + 1);
    }
  }
}

export interface HoldMetricsSnapshot {
  holdSet: HoldSetCounters[];
  holdAutoClear: HoldClearCounters[];
  runnerDeath: {
    count: number;
    sumSeconds: number;
    buckets: Array<{ leSeconds: number; count: number }>;
  };
  dispatchBarrierSkips: DispatchBarrierCounters[];
}

export function getHoldMetricsSnapshot(): HoldMetricsSnapshot {
  return {
    holdSet: [...state.holdSet.values()],
    holdAutoClear: [...state.holdAutoClear.values()],
    runnerDeath: {
      count: state.runnerDeath.count,
      sumSeconds: state.runnerDeath.sumSeconds,
      buckets: RUNNER_DEATH_BUCKETS_SECONDS.map((leSeconds) => ({
        leSeconds,
        count: state.runnerDeath.bucketsLeq.get(leSeconds) ?? 0,
      })),
    },
    dispatchBarrierSkips: [...state.dispatchBarrierSkips.values()],
  };
}

export function resetHoldMetricsForTest(): void {
  state = makeState();
}
