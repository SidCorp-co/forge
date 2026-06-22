import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { getJobsForRun, getRunsForIssue } from './queries.js';

export interface CandidateSignal {
  signalType: string;
  signalKey: string;
  summary: string;
  evidence: { runId: string; issueId: string; at: string };
}

/**
 * Detect repeated review→fix cycles on the same issue (reopen loop).
 * Signal key is `reopen_loop:<category>` so distinct issues with the same
 * category accrue toward one candidate (coarse-but-useful granularity).
 */
export async function extractReopenLoop(
  runId: string,
  projectId: string,
  issueId: string,
): Promise<CandidateSignal[]> {
  const [issue] = await db
    .select({ category: issues.category, reopenCount: issues.reopenCount })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  if (!issue || issue.reopenCount < 1) return [];

  const pastRuns = await getRunsForIssue(issueId);
  // Count how many past runs included a fix job (proxy for a reopen cycle).
  let fixRunCount = 0;
  for (const run of pastRuns) {
    const jobs = await getJobsForRun(run.id);
    if (jobs.some((j) => j.type === 'fix')) fixRunCount++;
  }

  // Also check the current run.
  const currentJobs = await getJobsForRun(runId);
  const currentHasFix = currentJobs.some((j) => j.type === 'fix');
  if (currentHasFix) fixRunCount++;

  if (fixRunCount < 1) return [];

  const category = issue.category ?? 'unknown';
  return [
    {
      signalType: 'reopen_loop',
      signalKey: `reopen_loop:${category}`,
      summary: `Issues in category "${category}" trigger repeated review→fix cycles (observed ${fixRunCount} fix run${fixRunCount === 1 ? '' : 's'}).`,
      evidence: { runId, issueId, at: new Date().toISOString() },
    },
  ];
}
