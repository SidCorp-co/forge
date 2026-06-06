/**
 * Dispatch / runner observability counters surfaced for Prometheus / Grafana.
 * ISS-228 — `dispatch_barrier_skips_total{reason}` so the pg-boss-path barrier
 * ({@link assertDispatchable}) reports a per-reason skip counter the same way
 * the picker does. ISS-393 removed the manual-hold counters along with the
 * manual-hold failure model; what remains here is dispatch/runner-liveness
 * telemetry (the filename is kept to avoid churn on the test mock paths).
 *
 * We don't pull in a full prom-client wiring here (no metrics endpoint yet);
 * instead we maintain in-process counters that can be scraped via the
 * existing admin/health surface. Once a metrics endpoint lands in core the
 * `getHoldMetricsSnapshot` shape is what gets serialized.
 *
 * Metrics:
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
    runnerDeath: histogram,
    dispatchBarrierSkips: new Map(),
  };
}

let state: HoldMetricsState = makeState();

/**
 * ISS-228 — increment `dispatch_barrier_skips_total{reason}` every time
 * the pg-boss path leaves a job queued because `assertDispatchable`
 * reported a failing gate. Operators watch the `project_cap` series to
 * detect cascade attempts (5+ skips in 90s, ISS-228 forge-dev incident).
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
  runnerDeath: {
    count: number;
    sumSeconds: number;
    buckets: Array<{ leSeconds: number; count: number }>;
  };
  dispatchBarrierSkips: DispatchBarrierCounters[];
}

export function getHoldMetricsSnapshot(): HoldMetricsSnapshot {
  return {
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
