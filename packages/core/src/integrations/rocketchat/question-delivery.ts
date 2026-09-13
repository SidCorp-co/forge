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
import { logger } from '../../logger.js';
import { resolveNotifications } from '../../notifications/auto-resolve.js';
import { emitNotification } from '../../notifications/emit.js';
import { listActiveBindingsForProjectProvider } from '../store.js';
import { sendFixedReply } from './outbound.js';
import { agentAuthoredSegments, renderRound } from './question-render.js';
import { screenOperatorMessage } from './reply-guard.js';
import { resolveRoomPostAuth } from './room-delivery.js';
import { registerThread, threadForQuestion } from './thread-registry.js';
import type { RocketChatBindingConfig } from './types.js';

const RETRY_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 8;
// cm:guard an undeliverable round is NOT capped by MAX_ATTEMPTS and retries flat forever, because what it waits on is a person binding a room — a capped retry would make a room bound an hour late deliver nothing, which is the one thing criterion 25 forbids.
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
// cm:guard derived from `agent_questions` and never from a queue of its own: a row this query cannot see is a question nobody was told about, and the only way to keep that impossible is for the obligation to be the QUESTION rather than a record of intent to deliver it (ISS-978 criterion 5).
// cm:guard `jsonb_array_length(steps)` is the round, because `askFollowUp` appends a step rather than writing a second row — reading a `round` column that does not exist is how a follow-up would look already delivered.
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
// cm:guard the FIRST rid of the first active binding, matching `connection-manager.ts:buildRoutes`, which takes the first binding per room from a `desc(createdAt)` ordering — two answers to "which room is this project's" is how a question is delivered to a room nobody is watching.
export async function roomForProject(projectId: string): Promise<RoomBinding | null> {
  const bindings = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  for (const { binding } of bindings) {
    const rid = ((binding.config as RocketChatBindingConfig | null)?.rids ?? [])[0];
    if (rid) return { connectionId: binding.connectionId, rid };
  }
  return null;
}

const undeliverableKey = (questionId: string) => `rocketchat-question-undeliverable:${questionId}`;

// cm:guard the person told is the org's creator, resolved as `escalation-bridge.ts` resolves it, because a project with NO binding has no route to read a principal off — and a question nobody can be told about is exactly the state this notification exists to make visible (ISS-978 criterion 24).
// cm:guard fired ONCE per question, on the move into undeliverable and never on the retries after it: `createNotification` inserts unconditionally — `resolutionKey` is what a later resolver clears, not a dedup key — so a per-retry call would put a row in somebody's list every five minutes for as long as the project has no room.
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
    title: `${row.name} has a parked question and no chat room to ask it in`,
    body: `A run is parked waiting on a person, and no Rocket.Chat room is bound to ${row.slug}. Bind one and the question is delivered on the next sweep — the run does not have to ask again.`,
    resolutionKey: undeliverableKey(owed.questionId),
  });
}

/**
 * Take this round, so no other core instance posts it too. Null when somebody else holds it.
 */
// cm:guard ONE statement, and the `where` on the conflict branch is what makes it a claim: the drain runs on EVERY core instance, and the DDP connection's advisory lock guards the socket rather than this table. Two instances deriving the same owed round and both posting is a question asked twice in one room, and `onConflictDoUpdate` without this predicate prevents only the second ROW (ISS-978 criterion 5).
// cm:guard the claim is written BEFORE the post and is deliberately not `delivered`: it says an attempt is in flight, never that one succeeded, so a claim whose process died is retried the moment its `next_attempt_at` passes rather than being mistaken for a delivery (ISS-978 criterion 6).
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
      // cm:guard serialise to ISO and cast before binding — postgres-js throws on a raw `Date` param at bind time, so the claim fails rather than mis-selecting and the whole drain is lost.
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
// cm:guard the ORDER is the contract: claim, then post, then mark delivered. Claiming first stops a second core instance posting the same round; marking last is what keeps `delivered` a statement about a post that returned a message id rather than about one that was attempted (ISS-978 criteria 5, 6, 7, 8).
// cm:guard a follow-up round posts into the FIRST round's thread and never opens a second one: one decision is one thread, matching the one-row-per-decision rule `agent_questions` holds (ISS-978 criterion 9).
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

  const verdict = screenOperatorMessage(agentAuthoredSegments(step));
  if (!verdict.ok) {
    // cm:guard the refusal is NOT posted as a fallback message into the room: the only text this round has is the text that failed the screen, and posting a stand-in would tell somebody a decision is waiting while hiding what it is. The round stays owed and the log names the problems (ISS-978 criterion 28).
    logger.error(
      { questionId: owed.questionId, round: owed.round, problems: verdict.problems },
      'rocketchat.question-delivery: the round was refused by the operator screen; not posted',
    );
    await noteFailure(owed, `screen refused the round: ${verdict.problems.join('; ')}`, now);
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
    issueKey: issue?.issSeq ? `ISS-${issue.issSeq}` : null,
    step,
    rounds: question.steps.length,
    parkDeadlineAt: question.parkDeadlineAt ?? null,
  });

  try {
    const receipt = await sendFixedReply(
      { kind: 'rest', auth, rid: room.rid, ...(existingThread ? { tmid: existingThread } : {}) },
      text,
      { ok: true, problems: verdict.problems },
    );
    const tmid = existingThread ?? receipt.messageId;
    if (!tmid) {
      await noteFailure(owed, 'the post named no message id, so no thread can be registered', now);
      return 'failed';
    }
    // cm:guard the thread is registered BEFORE the round is marked delivered: a round marked delivered with no thread row is a message in a room whose replies reach nothing, and this order makes that state unreachable rather than merely unlikely (ISS-978 criterion 7).
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
// cm:guard runs even with zero live connections and keeps running when every dial fails, because what it drains is derived from `agent_questions`: a project that has just had its first room bound is delivered by this timer and by nothing the binding itself did (ISS-978 criterion 25).
// cm:guard one drain at a time — a tick that overlaps its predecessor would re-derive the same owed rounds and post a question twice, since a round is not marked until its post returns.
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
