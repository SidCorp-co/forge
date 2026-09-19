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
