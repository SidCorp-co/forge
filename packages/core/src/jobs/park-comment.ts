// The comment a human (or the next agent) reads to understand why an issue is
// sitting at `waiting`. Without it, the only record of an exhausted stage is a
// job-count in `pipeline_runs` — ISS-213 burned 254 failed attempts across two
// runs and then re-dispatched to `code` with nothing anywhere explaining it, so
// the next agent could not tell "re-verify a regression" from "redundant
// re-dispatch of work that already shipped".

import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type ActorType, comments, type IssueStatus, jobs, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import {
  LIFECYCLE_GUIDE_POINTER,
  PARK_EXIT_RULE,
  type ParkedStatus,
} from '../pipeline/park-states.js';
import { REOPEN_CAP } from '../pipeline/state-machine.js';

export interface ParkReasonInput {
  issueId: string;
  projectId: string;
  /** Job type of the step that exhausted (e.g. `code`, `test`). */
  jobType: string;
  /** Stage status the step ran at, when known. */
  stageStatus?: string | null;
  /** `retry_rounds_exhausted` | `non_retryable_terminal` | … — why no retry followed. */
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

// cm:guard `isAi: true` is load-bearing, not cosmetic — bounce-replay-guard's needs_info release rule ignores AI-authored comments (ISS-820), so a system explanation posted as human input could release a bounce it was only describing
// cm:why best-effort and never rethrown — the park transition and run-reap that follow are the correctness-critical work; losing the explanatory comment must not also lose the cleanup. The body builder runs INSIDE the try so a formatting slip cannot escape either.
async function postAiComment(
  target: { issueId: string; projectId: string },
  label: string,
  buildLines: () => string[] | Promise<string[]>,
): Promise<void> {
  try {
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, target.projectId))
      .limit(1);
    if (!project) return;

    await db.insert(comments).values({
      issueId: target.issueId,
      authorId: project.createdBy,
      body: (await buildLines()).join('\n'),
      isAi: true,
    });
  } catch (err) {
    logger.warn(
      { err, issueId: target.issueId },
      `park-comment: failed to post ${label}, continuing`,
    );
  }
}

function buildParkReasonBody(input: ParkReasonInput, attempts: number): string[] {
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
  return lines;
}

export async function postParkReasonComment(input: ParkReasonInput): Promise<void> {
  await postAiComment(input, 'park-reason comment', async () =>
    buildParkReasonBody(input, await countFailedAttempts(input.issueId, input.jobType)),
  );
}

export interface SkippedParkExitInput {
  issueId: string;
  projectId: string;
  /** The park the issue just left. */
  from: ParkedStatus;
  /** Status now recorded on the issue — real, but nothing is working on it. */
  to: IssueStatus;
  /** Actor type that made the move, so the reader can see why it did not count. */
  actorType: ActorType;
}

function buildSkippedParkExitBody(input: SkippedParkExitInput): string[] {
  return [
    `⚠️ **Status is now \`${input.to}\`, but NO job was dispatched.**`,
    '',
    `The issue left \`${input.from}\` via a \`${input.actorType}\` actor. The status change is real; the work is not queued, and nothing will pick it up on its own.`,
    '',
    PARK_EXIT_RULE,
    '',
    `**Park semantics, and how to resume:** \`${LIFECYCLE_GUIDE_POINTER}\`.`,
  ];
}

// cm:why the sibling park comments post BEFORE their transition; this one cannot — it runs from the post-commit `transition` hook, so the status is already written and the earliest possible moment is here
// cm:guard without this comment the skip leaves NO issue-visible trace (only a server logger.info), so the issue sits at a live auto stage with no job and nothing explaining why — that is the state-never-lies violation this exists to close
export async function postSkippedParkExitComment(input: SkippedParkExitInput): Promise<void> {
  await postAiComment(input, 'skipped-park-exit comment', () => buildSkippedParkExitBody(input));
}

export interface ReopenCapEscalationInput {
  issueId: string;
  projectId: string;
  /** Status the reopen would have entered from (the stage that hit the cap). */
  fromStatus: IssueStatus;
  /** Count at the moment the cap was hit — does NOT increment on this redirect. */
  reopenCount: number;
  /** What the actor asked for (always `reopen` today, kept explicit for the caller's contract). */
  requestedStatus: IssueStatus;
}

function buildReopenCapEscalationBody(input: ReopenCapEscalationInput): string[] {
  return [
    '🛑 **Reopen cap reached — parked at `waiting` instead of looping again.**',
    '',
    `**Stage:** \`${input.fromStatus}\` requested \`${input.requestedStatus}\`, redirected to \`waiting\`.`,
    `**Reopen count:** \`${input.reopenCount}\` (cap \`${REOPEN_CAP}\`) — unchanged by this redirect.`,
    '',
    'This is a deliberate stop, not a failure: repeated reopen→fix→review passes cost real money and wall-clock, so the pipeline hands the decision to a human instead of looping a 6th time.',
    '',
    '**Operator exits:**',
    '- Override the cap and resume: an admin can force the reopen (`overrideReopenCap`) and resume the paused run.',
    '- Split the issue: if the churn suggests this issue is too large, decompose it instead of continuing to reopen this one.',
    '',
    'Do not retry the reopen — it will hit the same cap. Report this outcome instead.',
  ];
}

// cm:edge ordering -> packages/core/src/issues/apply-transition.ts — caller posts this BEFORE writing the redirected status, same contract as postParkReasonComment above
export async function postReopenCapEscalationComment(
  input: ReopenCapEscalationInput,
): Promise<void> {
  await postAiComment(input, 'reopen-cap escalation comment', () =>
    buildReopenCapEscalationBody(input),
  );
}
