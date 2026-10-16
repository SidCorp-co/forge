/**
 * A release whose agent stopped on a question waits for a person's answer instead of asking again.
 *
 * The agent's pane was ended `Blocked` and its question carried here. The blocked job fails without
 * a retry, and a held successor of it waits under the release run: a held job is what keeps the
 * run from being closed as concluded, the run being open is what refuses a second release for the
 * same members, and the roster stays at `releasing` under its claim. The questions are open human
 * questions on the first roster issue still claimed, and every other claimed member carries a
 * comment saying where. The last answer requeues the held job with the answers in its prompt; the
 * release ending voids what is still open.
 *
 * The held job's payload is the only link from a question to the release, and `DecisionRef` is the
 * one reader and writer of it, so the answer, the end, the state and the resume cannot disagree.
 */

import { and, eq, sql } from 'drizzle-orm';
import { forgeAuthorId } from '../comments/forge-author.js';
import { postSystemComment, withholdForIssue } from '../comments/system-write.js';
import { db, type Tx } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { comments, issues, jobs, pipelineRuns } from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { admitJob } from '../jobs/admit.js';
import type { PaneAsk } from '../jobs/blocked-wire.js';
import { buildRequeueUpdate, dispatchRequeuedJob, HOLD_PAYLOAD_KEY } from '../jobs/hold.js';
import { AUTO_RETRY_PAYLOAD_KEY } from '../jobs/retry.js';
import { logger } from '../logger.js';
import { paneQuestions } from '../questions/pane-question.js';
import { questionIdFor, writePaneQuestion } from '../questions/pane-question-write.js';
import { QuestionRefused, voidQuestion } from '../questions/write.js';
import { readAbortStamp } from './abort-stamp.js';
import {
  AWAITING_DECISION,
  DECISION_KEY,
  type DecisionQuestionView,
  type DecisionRef,
  decisionOfRun,
  type HeldDecision,
  heldDecisionOf,
  readDecisionQuestions,
  readDecisionRef,
} from './decision-state.js';
import { decisionsGivenSection, type GivenDecision } from './prompt.js';

type JobRow = typeof jobs.$inferSelect;

const WHO = 'release agent';

const HOLD_LOCK_NAMESPACE = 'release_decision_hold';

interface ClaimedMember {
  id: string;
  status: string;
}

/** The members the release still claims, in the order it named them, which is the order questions are placed. */
async function openMembers(runId: string, named: unknown): Promise<ClaimedMember[]> {
  const claimed = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.releaseBatchRunId, runId));
  const order = Array.isArray(named) ? named.filter((x): x is string => typeof x === 'string') : [];
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return claimed
    .filter((m) => !ISSUE_TERMINAL_STATUSES.includes(m.status as never))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function pointerBody(display: string): string {
  return `This issue's release is waiting on a decision: the ${WHO} stopped on a question, which is open on ${display}. Answer it there and the release goes on.`;
}

async function pointOthersAt(
  tx: Tx,
  others: readonly ClaimedMember[],
  anchorId: string,
): Promise<void> {
  const display = (await issueDisplayIds([anchorId], tx)).get(anchorId) ?? anchorId;
  const written = pointerBody(display);
  for (const member of others) {
    const body = await withholdForIssue(member.id, written, tx);
    const same = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, member.id), eq(comments.body, body)))
      .limit(1);
    if (same.length === 0) {
      await postSystemComment(
        { issueId: member.id, authorId: await forgeAuthorId(tx), body: written },
        tx,
      );
    }
  }
}

/**
 * Put what the blocked job's pane asked on the tracker and leave a held successor of the job under
 * its run. `null` where the run is not an open release, which leaves nothing to hold.
 */
export async function holdBlockedRelease(
  job: JobRow,
  asked: PaneAsk,
): Promise<HeldDecision | null> {
  const prior = await heldDecisionOf(job.id);
  if (prior) return prior;
  const [run] = await db
    .select({
      kind: pipelineRuns.kind,
      status: pipelineRuns.status,
      metadata: pipelineRuns.metadata,
    })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, job.pipelineRunId))
    .limit(1);
  const meta = (run?.metadata ?? {}) as Record<string, unknown>;
  const open = run?.status === 'running' || run?.status === 'paused';
  if (run?.kind !== 'system' || meta.source !== 'release-batch' || !open) return null;

  const members = await openMembers(job.pipelineRunId, meta.issueIds);
  const anchor = members[0]?.id ?? null;
  const panes = paneQuestions(asked, WHO);
  const questionIds = panes.map((_, i) => questionIdFor(job.id, i));
  const now = new Date().toISOString();
  const ref: DecisionRef = { v: 1, sourceJobId: job.id, questionIds, issueId: anchor, since: now };
  const { [AUTO_RETRY_PAYLOAD_KEY]: _spent, ...payload } = (job.payload ?? {}) as Record<
    string,
    unknown
  >;

  const written = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${HOLD_LOCK_NAMESPACE}), hashtext(${job.id}))`,
    );
    const raced = await heldDecisionOf(job.id, tx);
    if (raced) return raced;
    for (const [i, pane] of panes.entries()) {
      await writePaneQuestion(tx, {
        id: questionIds[i] as string,
        projectId: job.projectId,
        issueId: anchor,
        pane,
        who: WHO,
      });
    }
    if (anchor) await pointOthersAt(tx, members.slice(1), anchor);
    const held = await admitJob(tx, {
      projectId: job.projectId,
      issueId: job.issueId,
      pipelineRunId: job.pipelineRunId,
      createdBy: job.createdBy,
      type: job.type,
      payload: {
        ...payload,
        [HOLD_PAYLOAD_KEY]: { reason: AWAITING_DECISION, heldAt: now, autoRelease: false },
        [DECISION_KEY]: ref,
      },
      modelTier: job.modelTier,
      status: 'held',
      attempts: job.attempts,
      retryOf: job.id,
      failureReason: AWAITING_DECISION,
    });
    return { heldJobId: held.id, questionIds, issueId: anchor, replayed: false };
  });
  if (written.replayed) return written;
  const { heldJobId } = written;
  logger.info(
    { jobId: job.id, heldJobId, runId: job.pipelineRunId, anchor, questions: questionIds.length },
    'release-batch: a blocked release is held on a decision',
  );
  return { heldJobId, questionIds, issueId: anchor, replayed: false };
}

/** A decision ready to be handed back: every question answered, none withdrawn. */
function givenOf(views: readonly DecisionQuestionView[], expected: number): GivenDecision[] | null {
  if (
    views.length !== expected ||
    views.some((v) => v.status !== 'answered' || v.answer === null)
  ) {
    return null;
  }
  return views.map((v) => ({ question: v.prompt, answer: v.answer as string }));
}

/**
 * What a held job is requeued with once its whole decision is answered: the ordinary requeue, and the
 * answers written into its prompt. `null` while any question is open, withdrawn or missing. The
 * answer subscriber and an operator's resume both take their update from here, so a resume that
 * lands between the last answer and the subscriber still hands the agent what was decided.
 */
export async function answeredRequeue(
  job: JobRow,
  ref: DecisionRef,
): Promise<ReturnType<typeof buildRequeueUpdate> | null> {
  const given = givenOf(await readDecisionQuestions(ref.questionIds), ref.questionIds.length);
  if (!given) return null;
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const base = buildRequeueUpdate(job, new Date());
  const prompt = typeof payload.promptString === 'string' ? payload.promptString : '';
  return {
    ...base,
    payload: {
      ...base.payload,
      promptString: `${prompt}\n${decisionsGivenSection(given)}`,
      [DECISION_KEY]: { ...ref, answeredAt: new Date().toISOString() },
    },
  };
}

/**
 * The answer to one question of a held decision. Once every question is answered the held job is
 * requeued, once, with the answers in its prompt; `true` when this call requeued it.
 */
export async function requeueOnAnswer(questionId: string): Promise<boolean> {
  const held = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'held'),
        sql`payload -> ${DECISION_KEY} -> 'questionIds' @> ${JSON.stringify([questionId])}::jsonb`,
      ),
    );
  let requeued = false;
  for (const job of held) {
    let ref: DecisionRef | null;
    try {
      ref = readDecisionRef(job.id, job.payload);
    } catch (err) {
      logger.error(
        { err, jobId: job.id, questionId },
        'release-batch: a held decision cannot be read',
      );
      continue;
    }
    if (!ref) continue;
    const answered = await answeredRequeue(job, ref);
    if (!answered) continue;
    const [updated] = await withKernelMarker(db, async (tx) =>
      tx
        .update(jobs)
        .set(answered)
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.status, 'held'),
            sql`EXISTS (SELECT 1 FROM pipeline_runs r WHERE r.id = ${jobs.pipelineRunId} AND r.status IN ('running', 'paused'))`,
          ),
        )
        .returning({ id: jobs.id, type: jobs.type, issueId: jobs.issueId }),
    );
    if (!updated) continue;
    await dispatchRequeuedJob(updated);
    logger.info(
      { jobId: job.id, questionId },
      'release-batch: a held release has its decision and goes on',
    );
    requeued = true;
  }
  return requeued;
}

/** The release ended with a decision still open: nothing waits on it any more, and it is voided saying why. */
export async function voidOnRunEnd(runId: string, toStatus: string): Promise<number> {
  const decision = await decisionOfRun(runId);
  if (!decision) return 0;
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  const stamp = readAbortStamp(run?.metadata ?? null);
  const reason = stamp
    ? `The release was aborted (${stamp.reason}), so nothing waits on this answer.`
    : `The release ended ${toStatus}, so nothing waits on this answer.`;
  let voided = 0;
  for (const questionId of decision.ref.questionIds) {
    try {
      await voidQuestion({ questionId, reason });
      voided += 1;
    } catch (err) {
      if (!(err instanceof QuestionRefused) || err.code !== 'QUESTION_NOT_OPEN') throw err;
    }
  }
  return voided;
}
