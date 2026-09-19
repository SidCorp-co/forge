// Carrying a parked run's question to a room, and remembering which thread it went to.
//
// The obligation is DERIVED, never inserted: an open `human` question whose
// latest round has no delivered row here is a round still owed to somebody. So
// `questions/` writes nothing for this lane and imports nothing from here, and
// a core that dies between the kernel commit and any emit leaves the work to be
// found on the next drain rather than lost.

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues, organizations, projects } from '../../db/schema.js';
import { agentQuestions, type QuestionOrigin } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import { screenForDoor } from '../../messaging/proven.js';
import { resolveNotifications } from '../../notifications/auto-resolve.js';
import { emitNotification } from '../../notifications/emit.js';
import { sendFixedReply } from './outbound.js';
import { isUnreachableRoom, resolveQuestionDestination } from './question-destination.js';
import { renderRound } from './question-render.js';
import { resolveRoomPostAuth } from './room-delivery.js';
import { registerThread, releaseQuestionThread } from './thread-registry.js';

const RETRY_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 8;
const UNBOUND_RETRY_MS = 300_000;

export interface OwedRound {
  questionId: string;
  projectId: string;
  issueId: string | null;
  round: number;
  attempts: number;
  /** This round has already been reported as having nowhere to go. */
  wasUndeliverable: boolean;
}

/**
 * Every round a room is still owed, whether or not it has ever been attempted.
 */
export async function owedRounds(now: Date = new Date()): Promise<OwedRound[]> {
  const round = sql<number>`jsonb_array_length(${agentQuestions.steps})`;
  const rows = await db
    .select({
      questionId: agentQuestions.id,
      projectId: agentQuestions.projectId,
      issueId: agentQuestions.issueId,
      round,
      attempts: rocketchatQuestionDeliveries.attempts,
      status: rocketchatQuestionDeliveries.status,
    })
    .from(agentQuestions)
    .leftJoin(
      rocketchatQuestionDeliveries,
      and(
        eq(rocketchatQuestionDeliveries.questionId, agentQuestions.id),
        eq(rocketchatQuestionDeliveries.round, round),
      ),
    )
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        or(
          isNull(rocketchatQuestionDeliveries.id),
          and(
            sql`${rocketchatQuestionDeliveries.status} <> 'delivered'`,
            or(
              sql`${rocketchatQuestionDeliveries.status} = 'undeliverable'`,
              sql`${rocketchatQuestionDeliveries.attempts} < ${MAX_ATTEMPTS}`,
            ),
            or(
              isNull(rocketchatQuestionDeliveries.nextAttemptAt),
              lte(rocketchatQuestionDeliveries.nextAttemptAt, now),
            ),
          ),
        ),
      ),
    );
  return rows.map((r) => ({
    questionId: r.questionId,
    projectId: r.projectId,
    issueId: r.issueId,
    round: r.round,
    attempts: r.attempts ?? 0,
    wasUndeliverable: r.status === 'undeliverable',
  }));
}

const undeliverableKey = (questionId: string) => `rocketchat-question-undeliverable:${questionId}`;

async function reportUndeliverable(
  owed: OwedRound,
  already: boolean,
  reason: string,
): Promise<void> {
  if (already) return;
  const [row] = await db
    .select({ slug: projects.slug, name: projects.name, createdBy: organizations.createdBy })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, owed.projectId))
    .limit(1);
  if (!row?.createdBy) return;
  await emitNotification({
    userId: row.createdBy,
    projectId: owed.projectId,
    issueId: owed.issueId,
    type: 'ops_alert',
    severity: 'warning',
    title: `${row.name} has a question waiting that cannot be delivered`,
    body: `A question is waiting on a person and ${row.slug} has nowhere to put it: ${reason}. Nothing was posted anywhere. Put that right and the question is delivered on the next sweep — whoever asked does not have to ask again.`,
    resolutionKey: undeliverableKey(owed.questionId),
  });
}

/**
 * Take this round, so no other core instance posts it too. Null when somebody else holds it.
 */
async function claimRound(owed: OwedRound, now: Date): Promise<number | null> {
  const attempts = sql<number>`coalesce(${rocketchatQuestionDeliveries.attempts}, 0) + 1`;
  const claimed = await db
    .insert(rocketchatQuestionDeliveries)
    .values({
      questionId: owed.questionId,
      round: owed.round,
      status: 'claimed',
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [rocketchatQuestionDeliveries.questionId, rocketchatQuestionDeliveries.round],
      set: {
        status: 'claimed',
        attempts,
        nextAttemptAt: sql`${now.toISOString()}::timestamptz + (${RETRY_BACKOFF_MS} * (${attempts})) * interval '1 millisecond'`,
        updatedAt: now,
      },
      setWhere: sql`${rocketchatQuestionDeliveries.status} <> 'delivered' and (${rocketchatQuestionDeliveries.nextAttemptAt} is null or ${rocketchatQuestionDeliveries.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
    })
    .returning({ attempts: rocketchatQuestionDeliveries.attempts });
  const row = claimed[0];
  if (!row) return null;
  if (typeof row.attempts !== 'number') {
    throw new Error(
      `rocketchat.question-delivery: the claim on question ${owed.questionId} round ${owed.round} returned a row with no attempt count`,
    );
  }
  return row.attempts;
}

async function settle(
  owed: OwedRound,
  patch: { status: 'delivered' | 'undeliverable'; lastError?: string | null },
  now: Date,
): Promise<void> {
  await db
    .update(rocketchatQuestionDeliveries)
    .set({
      status: patch.status,
      lastError: patch.lastError ?? null,
      nextAttemptAt:
        patch.status === 'delivered' ? null : new Date(now.getTime() + UNBOUND_RETRY_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
        eq(rocketchatQuestionDeliveries.round, owed.round),
      ),
    );
}

async function noteFailure(
  owed: OwedRound,
  attempt: number,
  lastError: string,
  now: Date,
): Promise<'failed' | 'undeliverable'> {
  if (attempt >= MAX_ATTEMPTS) {
    return refuse(
      owed,
      `this round failed ${attempt} times and will not be retried on the ordinary schedule — the last failure was: ${lastError}`,
      now,
    );
  }
  await db
    .update(rocketchatQuestionDeliveries)
    .set({ lastError, updatedAt: now })
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
        eq(rocketchatQuestionDeliveries.round, owed.round),
      ),
    );
  return 'failed';
}

/**
 * Deliver one owed round. Never throws — a failure is a record, not an exception.
 */
export async function deliverOwedRound(
  owed: OwedRound,
  now: Date = new Date(),
): Promise<'delivered' | 'failed' | 'undeliverable' | 'held'> {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, owed.questionId))
    .limit(1);
  if (!question) return 'failed';
  const step = question.steps[owed.round - 1];
  if (!step) return 'failed';

  const attempt = await claimRound(owed, now);
  if (attempt === null) return 'held';

  const destination = await resolveQuestionDestination({
    questionId: owed.questionId,
    projectId: owed.projectId,
    origin: question.origin ?? null,
    step,
  });
  if (destination.kind === 'unresolvable') {
    return refuse(owed, destination.reason, now);
  }

  const [issue] = owed.issueId
    ? await db
        .select({ issSeq: issues.issSeq })
        .from(issues)
        .where(eq(issues.id, owed.issueId))
        .limit(1)
    : [];
  const screening = screenForDoor(
    'question-delivery',
    renderRound({
      issueKey: issue?.issSeq
        ? formatIssueRef(await activeIssuePrefix(owed.projectId), issue.issSeq)
        : null,
      step,
      rounds: question.steps.length,
      parkDeadlineAt: question.parkDeadlineAt ?? null,
      askedBy: askerOf(question.origin ?? null),
    }),
  );
  if (!screening.ok) {
    logger.error(
      {
        questionId: owed.questionId,
        round: owed.round,
        problems: problemsOf(screening.verdict),
      },
      'rocketchat.question-delivery: the round was refused by the operator screen; not posted',
    );
    return await noteFailure(
      owed,
      attempt,
      `screen refused the round: ${problemsOf(screening.verdict).join('; ')}`,
      now,
    );
  }

  const auth = await resolveRoomPostAuth(destination.connectionId, {
    source: 'rocketchat.question-delivery',
    questionId: owed.questionId,
  });
  if (!auth) {
    return await noteFailure(owed, attempt, 'the connection carries no usable credentials', now);
  }

  const ref = {
    connectionId: destination.connectionId,
    rid: destination.rid,
    tmid: destination.tmid ?? '',
  };
  if (destination.takeAnchor && destination.tmid) {
    const took = await registerThread({ questionId: owed.questionId }, ref);
    if (!took) {
      return refuse(
        owed,
        `the message this question was raised against (${destination.tmid}) is already another thread's root, so this round cannot be hung under it`,
        now,
      );
    }
  }

  let receipt: { messageId: string | null };
  try {
    receipt = await sendFixedReply(
      {
        kind: 'rest',
        auth,
        rid: destination.rid,
        ...(destination.tmid ? { tmid: destination.tmid } : {}),
      },
      screening.proven.text,
      screening.proven,
    );
  } catch (err) {
    await releaseTakenAnchor(destination, owed.questionId);
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid: destination.rid },
      'rocketchat.question-delivery: posting the round failed',
    );
    if (isUnreachableRoom(err)) {
      return refuse(
        owed,
        `this bot can no longer post in room ${destination.rid}, which is where this question was asked`,
        now,
      );
    }
    return await noteFailure(owed, attempt, err instanceof Error ? err.message : String(err), now);
  }

  try {
    const tmid = destination.tmid ?? receipt.messageId;
    if (!tmid) {
      return await noteFailure(
        owed,
        attempt,
        'the post named no message id, so no thread can be registered',
        now,
      );
    }
    await registerThread(
      { questionId: owed.questionId },
      { connectionId: destination.connectionId, rid: destination.rid, tmid },
    );
    await settle(owed, { status: 'delivered' }, now);
    await resolveNotifications(undeliverableKey(owed.questionId));
    return 'delivered';
  } catch (err) {
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid: destination.rid },
      'rocketchat.question-delivery: the round was posted and recording it failed',
    );
    return await noteFailure(owed, attempt, err instanceof Error ? err.message : String(err), now);
  }
}

/** Settle this round undeliverable, tell the operator once, and post nothing anywhere. */
async function refuse(owed: OwedRound, reason: string, now: Date): Promise<'undeliverable'> {
  await settle(owed, { status: 'undeliverable', lastError: reason }, now);
  await reportUndeliverable(owed, owed.wasUndeliverable, reason);
  return 'undeliverable';
}

/** Give back an anchor this attempt took, and only one this attempt took. */
async function releaseTakenAnchor(
  destination: { takeAnchor: boolean; connectionId: string; rid: string; tmid: string | null },
  questionId: string,
): Promise<void> {
  if (!destination.takeAnchor || !destination.tmid) return;
  await releaseQuestionThread(questionId, {
    connectionId: destination.connectionId,
    rid: destination.rid,
    tmid: destination.tmid,
  });
}

/** Who this round is being put to, where the question remembers. */
function askerOf(origin: QuestionOrigin | null): string | null {
  return origin?.kind === 'conversation' ? origin.askedByLabel : null;
}

export interface QuestionDrainResult {
  owed: number;
  delivered: number;
  failed: number;
  undeliverable: number;
  /** Rounds another core instance was already posting. */
  held: number;
}

export async function drainQuestionDeliveries(
  clock: Date | (() => Date) = () => new Date(),
): Promise<QuestionDrainResult> {
  const at = typeof clock === 'function' ? clock : (): Date => clock;
  const owed = await owedRounds(at());
  const result: QuestionDrainResult = {
    owed: owed.length,
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
  };
  for (const round of owed) {
    const outcome = await deliverOwedRound(round, at());
    result[outcome] += 1;
  }
  return result;
}

/** The drain is a backstop, not the fast path: a newly asked question goes out on the next tick. */
const DRAIN_INTERVAL_MS = 30_000;

/**
 * Run the drain on a timer until the returned stopper is called.
 */
export function startQuestionDrainLoop(alive: () => boolean): () => void {
  let running = false;
  const tick = (): void => {
    if (running || !alive()) return;
    running = true;
    void drainQuestionDeliveries()
      .then((r) => {
        if (r.owed > 0) logger.info({ ...r }, 'rocketchat: question delivery drain');
      })
      .catch((err) => logger.error({ err }, 'rocketchat: question delivery drain failed'))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, DRAIN_INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
