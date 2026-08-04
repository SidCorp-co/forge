// The comment a human (or the next agent) reads to understand why an issue is
// sitting at `waiting`. Without it, the only record of an exhausted stage is a
// job-count in `pipeline_runs` — ISS-213 burned 254 failed attempts across two
// runs and then re-dispatched to `code` with nothing anywhere explaining it, so
// the next agent could not tell "re-verify a regression" from "redundant
// re-dispatch of work that already shipped".

import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, jobs, projects } from '../db/schema.js';
import { logger } from '../logger.js';

export interface ParkReasonInput {
  issueId: string;
  projectId: string;
  /** Job type of the step that exhausted (e.g. `code`, `test`). */
  jobType: string;
  /** Stage status the step ran at, when known. */
  stageStatus?: string | null;
  /** `retry_rounds_exhausted` | `non_retryable_code` | … — why no retry followed. */
  reason: string;
  /** Classified failure kind (`transient`, `code`, `transient-cc`, …). */
  failureKind?: string | null;
  /** Last failure message, already scrubbed by the caller's classifier. */
  failureReason?: string | null;
}

function truncate(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Count failed attempts for this issue's step — the number a reader would
 * otherwise have to reconstruct by hand from the run's job rows.
 */
async function countFailedAttempts(issueId: string, jobType: string): Promise<number> {
  try {
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.issueId, issueId), eq(jobs.type, jobType as never), ne(jobs.status, 'done')),
      );
    return rows.length;
  } catch {
    return 0;
  }
}

// cm:why best-effort and never rethrown — the park transition and run-reap that follow are the correctness-critical work; losing the explanatory comment must not also lose the cleanup
export async function postParkReasonComment(input: ParkReasonInput): Promise<void> {
  try {
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    if (!project) return;

    const attempts = await countFailedAttempts(input.issueId, input.jobType);
    const lines = [
      '⏸️ **Parked at `waiting`** — the pipeline stopped retrying this step.',
      '',
      `**Step:** \`${input.jobType}\`${input.stageStatus ? ` (stage \`${input.stageStatus}\`)` : ''}`,
      `**Why no retry:** \`${input.reason}\`${input.failureKind ? ` (failure kind \`${input.failureKind}\`)` : ''}`,
      `**Non-successful attempts on this step:** ${attempts}`,
    ];
    if (input.failureReason) {
      lines.push('', '**Last failure:**', '```', truncate(input.failureReason), '```');
    }
    lines.push(
      '',
      // cm:guard say this explicitly — a re-dispatched agent that assumes the work is unfinished will redo shipped work, which is exactly what happened on the incident this comment exists to prevent
      'This says the STEP stopped, not that the work is undone. Before redoing anything, verify the current real state (the deliverable may already be live) and read the failure above — if it is mechanical, fix that rather than re-running the step unchanged.',
    );

    await db.insert(comments).values({
      issueId: input.issueId,
      authorId: project.createdBy,
      body: lines.join('\n'),
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId },
      'park-comment: failed to post park-reason comment, continuing',
    );
  }
}
