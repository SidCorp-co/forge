import type { CandidateSignal } from './reopen-loop.js';
import { getProjectFixJobs } from './queries.js';

/** Normalise failure reason to a short bucket label (first meaningful token). */
function reasonBucket(reason: string | null): string {
  if (!reason) return 'unknown';
  const token = reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .slice(0, 32);
  return token || 'unknown';
}

/**
 * Detect the same fix pattern across multiple issues in the project.
 * Signal key: `repeated_fix:<failureKind>:<reasonBucket>`.
 * Only surfaces if the bucket recurs across ≥2 distinct issues.
 */
export async function extractRepeatedFixType(
  runId: string,
  projectId: string,
  issueId: string,
): Promise<CandidateSignal[]> {
  const fixJobs = await getProjectFixJobs(projectId);
  if (fixJobs.length < 2) return [];

  // Group by (failureKind, reasonBucket).
  const buckets = new Map<string, { issues: Set<string>; runIds: string[] }>();
  for (const job of fixJobs) {
    const kind = job.failureKind ?? 'unknown';
    const bucket = reasonBucket(job.failureReason);
    const key = `repeated_fix:${kind}:${bucket}`;
    const entry = buckets.get(key) ?? { issues: new Set(), runIds: [] };
    if (job.issueId) entry.issues.add(job.issueId);
    entry.runIds.push(job.runId);
    buckets.set(key, entry);
  }

  const signals: CandidateSignal[] = [];
  for (const [key, entry] of buckets) {
    if (entry.issues.size < 2) continue;
    const [, kind, bucket] = key.split(':');
    signals.push({
      signalType: 'repeated_fix_type',
      signalKey: key,
      summary: `Fix pattern "${kind}/${bucket}" recurs across ${entry.issues.size} distinct issues — possible recurring gotcha.`,
      evidence: { runId, issueId, at: new Date().toISOString() },
    });
  }
  return signals;
}
