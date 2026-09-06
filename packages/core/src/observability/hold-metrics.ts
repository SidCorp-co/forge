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
// cm:guard a counter here needs a live caller before it is added, and loses its place when the last one goes — three shipped with none, each reporting zero forever under a header that told an operator what to read into that zero (ISS-765, on the ISS-895 rule that an alarm which cannot fire reads as evidence the condition is absent).

import type { ResumeDropReason } from '../jobs/resume-policy.js';

interface ResumeDropCounters {
  reason: ResumeDropReason;
  count: number;
}

interface HoldMetricsState {
  resumeDrops: Map<ResumeDropReason, ResumeDropCounters>;
}

const state: HoldMetricsState = { resumeDrops: new Map() };

// cm:guard ISS-887 — `finalizeResumeForDevice` is the ONLY caller, and it must increment from the same `dropReason` it stamps on the attempt's `agent_sessions.metadata.resume`. NOT `resolveResumePolicy`, which deliberately increments nothing: its answer is provisional until a device is picked, and it once held this call, so a reader who moves it back re-opens the stale-pin drop it cannot see. A second call site, or one deriving its own reason, is how this rate and the per-attempt rows come to disagree about the same dispatch (`measured-together-never-apart`).
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
