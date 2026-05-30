// Per-job last-seen sequence numbers. In-memory only — stale on page reload,
// which is fine: React Query refetches on mount and the WS server replays
// from `sinceSeq=0` when the map is empty.
// Ported verbatim from `packages/web/src/lib/ws/seq-tracker.ts` (ISS-288).

const lastSeenByJob = new Map<string, number>();

export function trackJobSeq(jobId: string, seq: number): void {
  const prev = lastSeenByJob.get(jobId) ?? 0;
  if (seq > prev) lastSeenByJob.set(jobId, seq);
}

export function getJobSeq(jobId: string): number {
  return lastSeenByJob.get(jobId) ?? 0;
}

export function listTrackedJobs(): string[] {
  return Array.from(lastSeenByJob.keys());
}
