/**
 * A job pane ended while it waited on a person: what is done with the job and with what it asked.
 *
 * A release batch is held on the question (`release-batch/decision-hold.ts`) and its run goes on
 * under a held successor. Any other pool job fails without a retry, since the same work would stop
 * on the same question, and what it asked is put to the project's people at project level. Either
 * way the question is on the tracker where the people who owe the answer read, and no identical job
 * is queued for the same unchanged work.
 */

import { db } from '../db/client.js';
import type { JobStatus } from '../db/schema.js';
import { paneQuestions } from '../questions/pane-question.js';
import { questionIdFor, writePaneQuestion } from '../questions/pane-question-write.js';
import { holdBlockedRelease } from '../release-batch/decision-hold.js';
import type { HeldDecision } from '../release-batch/decision-state.js';
import { RELEASE_JOB_TYPE } from '../release-batch/job-start.js';
import type { BlockedBody } from './blocked-wire.js';
import { failOccupyingJob } from './fail-job.js';
import { readJob } from './job-queries.js';

export interface BlockedEnd {
  jobId: string;
  status: 'failed';
  /** The held successor a release batch waits on, `null` for a job nothing holds. */
  heldJobId: string | null;
  questionIds: string[];
  issueId: string | null;
  replayed: boolean;
}

/** A blocked report for a job that is gone. */
export class BlockedJobMissing extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} not found`);
    this.name = 'BlockedJobMissing';
  }
}

async function carryAtProjectLevel(
  job: NonNullable<Awaited<ReturnType<typeof readJob>>>,
  asked: BlockedBody['asked'],
): Promise<string[]> {
  const who = `${job.type} agent`;
  const panes = paneQuestions(asked, who);
  const ids = panes.map((_, i) => questionIdFor(job.id, i));
  await db.transaction(async (tx) => {
    for (const [i, pane] of panes.entries()) {
      await writePaneQuestion(tx, {
        id: ids[i] as string,
        projectId: job.projectId,
        issueId: null,
        pane,
        who,
      });
    }
  });
  return ids;
}

/**
 * Put what the pane asked where a person reads it, then fail the job without a retry. The
 * question is written first and the job fails last, so a report whose reply was lost can be sent
 * again and finds its question and its held job already there.
 */
export async function endBlockedJob(
  job: { id: string; status: JobStatus },
  deviceId: string,
  body: BlockedBody,
): Promise<BlockedEnd> {
  const full = await readJob(job.id);
  if (!full) throw new BlockedJobMissing(job.id);

  let held: HeldDecision | null = null;
  let questionIds: string[] = [];
  if (full.type === RELEASE_JOB_TYPE) {
    held = await holdBlockedRelease(full, body.asked);
    questionIds = held?.questionIds ?? [];
  } else {
    questionIds = await carryAtProjectLevel(full, body.asked);
  }

  await failOccupyingJob(
    job,
    deviceId,
    { error: body.error },
    {
      precomputedRetry: {
        scheduled: false,
        reason: held ? 'awaiting_decision' : 'blocked_on_question',
      },
      runContinues: held !== null,
    },
  );
  return {
    jobId: job.id,
    status: 'failed',
    heldJobId: held?.heldJobId ?? null,
    questionIds,
    issueId: held?.issueId ?? null,
    replayed: held?.replayed ?? false,
  };
}
