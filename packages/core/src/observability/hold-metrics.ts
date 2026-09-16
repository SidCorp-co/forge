/**
 * Dispatch / runner observability counters surfaced for Prometheus / Grafana.
 * ISS-393 removed the manual-hold counters along with the manual-hold failure
 * model; what remains here is the resume-drop counter (the filename is kept to
 * avoid churn on the test mock paths).
 *
 * We don't pull in a full prom-client wiring here (no metrics endpoint yet);
 * instead we maintain in-process counters that can be scraped via the
 * existing admin/health surface. Once a metrics endpoint lands in core the
 * `getHoldMetricsSnapshot` shape is what gets serialized.
 *
 * Metrics:
 *   - resume_drops_total{reason}: incremented by `finalizeResumeForDevice`
 *     when a resume attempt is dropped (ISS-887).
 */

import type { ResumeDropReason } from '../jobs/resume-policy.js';

interface ResumeDropCounters {
  reason: ResumeDropReason;
  count: number;
}

interface HoldMetricsState {
  resumeDrops: Map<ResumeDropReason, ResumeDropCounters>;
}

const state: HoldMetricsState = { resumeDrops: new Map() };

export function recordResumeDrop(reason: ResumeDropReason): void {
  const existing = state.resumeDrops.get(reason);
  if (existing) {
    existing.count += 1;
  } else {
    state.resumeDrops.set(reason, { reason, count: 1 });
  }
}

export interface HoldMetricsSnapshot {
  resumeDrops: ResumeDropCounters[];
}

export function getHoldMetricsSnapshot(): HoldMetricsSnapshot {
  return { resumeDrops: [...state.resumeDrops.values()] };
}
