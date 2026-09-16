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
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import { screenAtDoor } from '../../messaging/screen.js';
import { resolveNotifications } from '../../notifications/auto-resolve.js';
import { emitNotification } from '../../notifications/emit.js';
import { listActiveBindingsForProjectProvider } from '../store.js';
import { sendFixedReply } from './outbound.js';
import { agentAuthoredSegments, renderRound } from './question-render.js';
import { resolveRoomPostAuth } from './room-delivery.js';
import { registerThread, threadForQuestion } from './thread-registry.js';
import type { RocketChatBindingConfig } from './types.js';

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

export interface RoomBinding {
  connectionId: string;
  rid: string;
}

/** The room this project's questions go to, or null when nobody has bound one. */
export async function roomForProject(projectId: string): Promise<RoomBinding | null> {
  const bindings = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  for (const { binding } of bindings) {
    const rid = ((binding.config as RocketChatBindingConfig | null)?.rids ?? [])[0];
    if (rid) return { connectionId: binding.connectionId, rid };
  }
  return null;
}

const undeliverableKey = (questionId: string) => `rocketchat-question-undeliverable:${questionId}`;

async function reportUndeliverable(owed: OwedRound, already: boolean): Promise<void> {
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
    title: `${row.name} has a question waiting and no chat room to ask it in`,
    body: `A question is waiting on a person, and no Rocket.Chat room is bound to ${row.slug}. Bind one and the question is delivered on the next sweep — whoever asked does not have to ask again.`,
    resolutionKey: undeliverableKey(owed.questionId),
  });
}

/**
 * Take this round, so no other core instance posts it too. Null when somebody else holds it.
 */
async function claimRound(owed: OwedRound, now: Date): Promise<boolean> {
  const attempts = owed.attempts + 1;
  const nextAttemptAt = new Date(now.getTime() + RETRY_BACKOFF_MS * attempts);
  const claimed = await db
    .insert(rocketchatQuestionDeliveries)
    .values({
      questionId: owed.questionId,
      round: owed.round,
      status: 'claimed',
      attempts,
      nextAttemptAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [rocketchatQuestionDeliveries.questionId, rocketchatQuestionDeliveries.round],
      set: { status: 'claimed', attempts, nextAttemptAt, updatedAt: now },
      setWhere: sql`${rocketchatQuestionDeliveries.status} <> 'delivered' and (${rocketchatQuestionDeliveries.nextAttemptAt} is null or ${rocketchatQuestionDeliveries.nextAttemptAt} <= ${now.toISOString()}::timestamptz)`,
    })
    .returning({ id: rocketchatQuestionDeliveries.id });
  return claimed.length > 0;
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

async function noteFailure(owed: OwedRound, lastError: string, now: Date): Promise<void> {
  await db
    .update(rocketchatQuestionDeliveries)
    .set({ lastError, updatedAt: now })
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
        eq(rocketchatQuestionDeliveries.round, owed.round),
      ),
    );
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

  if (!(await claimRound(owed, now))) return 'held';

  const room = await roomForProject(owed.projectId);
  if (!room) {
    await settle(
      owed,
      { status: 'undeliverable', lastError: 'no Rocket.Chat room is bound to this project' },
      now,
    );
    await reportUndeliverable(owed, owed.wasUndeliverable);
    return 'undeliverable';
  }

  const verdict = screenAtDoor('question-delivery', agentAuthoredSegments(step));
  if (!verdict.ok) {
    logger.error(
      { questionId: owed.questionId, round: owed.round, problems: problemsOf(verdict) },
      'rocketchat.question-delivery: the round was refused by the operator screen; not posted',
    );
    await noteFailure(owed, `screen refused the round: ${problemsOf(verdict).join('; ')}`, now);
    return 'failed';
  }

  const auth = await resolveRoomPostAuth(room.connectionId, {
    source: 'rocketchat.question-delivery',
    questionId: owed.questionId,
  });
  if (!auth) {
    await noteFailure(owed, 'the connection carries no usable credentials', now);
    return 'failed';
  }

  const [issue] = owed.issueId
    ? await db
        .select({ issSeq: issues.issSeq })
        .from(issues)
        .where(eq(issues.id, owed.issueId))
        .limit(1)
    : [];
  const existingThread = await threadForQuestion(owed.questionId);
  const text = renderRound({
    issueKey: issue?.issSeq
      ? formatIssueRef(await activeIssuePrefix(owed.projectId), issue.issSeq)
      : null,
    step,
    rounds: question.steps.length,
    parkDeadlineAt: question.parkDeadlineAt ?? null,
  });

  try {
    const receipt = await sendFixedReply(
      { kind: 'rest', auth, rid: room.rid, ...(existingThread ? { tmid: existingThread } : {}) },
      text,
      { ok: true, problems: problemsOf(verdict) },
    );
    const tmid = existingThread ?? receipt.messageId;
    if (!tmid) {
      await noteFailure(owed, 'the post named no message id, so no thread can be registered', now);
      return 'failed';
    }
    await registerThread(
      { questionId: owed.questionId },
      { connectionId: room.connectionId, rid: room.rid, tmid },
    );
    await settle(owed, { status: 'delivered' }, now);
    await resolveNotifications(undeliverableKey(owed.questionId));
    return 'delivered';
  } catch (err) {
    logger.error(
      { err, questionId: owed.questionId, round: owed.round, rid: room.rid },
      'rocketchat.question-delivery: posting the round failed',
    );
    await noteFailure(owed, err instanceof Error ? err.message : String(err), now);
    return 'failed';
  }
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
  now: Date = new Date(),
): Promise<QuestionDrainResult> {
  const owed = await owedRounds(now);
  const result: QuestionDrainResult = {
    owed: owed.length,
    delivered: 0,
    failed: 0,
    undeliverable: 0,
    held: 0,
  };
  for (const round of owed) {
    const outcome = await deliverOwedRound(round, now);
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
