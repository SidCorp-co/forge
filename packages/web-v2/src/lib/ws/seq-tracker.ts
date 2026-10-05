
const lastSeenByJob = new Map<string, number>();

export function trackJobSeq(jobId: string, seq: number): void {
  const prev = lastSeenByJob.get(jobId) ?? 0;
  if (seq > prev) lastSeenByJob.set(jobId, seq);
}