
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
