// The delivery ledger of parked questions: which rounds a room is still owed, and the claim and
// settlement of each round through the room-delivery machine.
//
// The obligation is DERIVED, never inserted: an open `human` question whose latest round has no
// delivered row here is a round still owed to somebody. So `questions/` writes nothing for this
// lane and imports nothing from here, and a core that dies between the kernel commit and any emit
// leaves the work to be found on the next drain rather than lost.

import { QUESTION_DELIVERY_MACHINE } from '@forge/contracts/room-delivery-machine';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { sqlTimestamp } from '../../db/sql-timestamp.js';
import { type KernelActor, transition } from '../../lifecycle/index.js';

const DELIVERY_ACTOR: KernelActor = { type: 'system' };
const DELIVERY_SOURCE = 'chat-room.question-delivery';
const RETRY_BACKOFF_MS = 60_000;
export const MAX_ATTEMPTS = 8;
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
 * A question decided signed in to Forge — a channel approve gate, decided in Attention and on the
 * document's gate panel, or one asked in a web chat, answered there. No room is owed its rounds, so
 * a project with no room is the normal case for it and never an undeliverable alert.
 */
export const decidedOnTheWeb = sql`coalesce(
  ${agentQuestions.origin} ->> 'kind' = 'channel_gate'
  or (${agentQuestions.origin} ->> 'kind' = 'conversation' and ${agentQuestions.origin} ->> 'adapter' = 'web'),
  false
)`;

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
        sql`not ${decidedOnTheWeb}`,
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

/**
 * Take this round, so no other core instance posts it too. Null when somebody else holds it. A
 * first claim writes the row; a retry, once its backoff has run out, re-claims it through the kernel.
 */
export async function claimRound(owed: OwedRound, now: Date): Promise<number | null> {
  const created = await db
    .insert(rocketchatQuestionDeliveries)
    .values({
      questionId: owed.questionId,
      round: owed.round,
      status: 'claimed',
      attempts: 1,
      nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [rocketchatQuestionDeliveries.questionId, rocketchatQuestionDeliveries.round],
    })
    .returning({ attempts: rocketchatQuestionDeliveries.attempts });
  const attempts = sql<number>`coalesce(${rocketchatQuestionDeliveries.attempts}, 0) + 1`;
  const reclaimed = created[0]
    ? created
    : (
        await transition(db, QUESTION_DELIVERY_MACHINE, {
          to: 'claimed',
          from: ['claimed', 'undeliverable'],
          where: and(
            roundOf(owed),
            or(
              isNull(rocketchatQuestionDeliveries.nextAttemptAt),
              lte(rocketchatQuestionDeliveries.nextAttemptAt, now),
            ),
          ),
          set: {
            attempts,
            nextAttemptAt: sql`${sqlTimestamp(now)} + (${RETRY_BACKOFF_MS} * (${attempts})) * interval '1 millisecond'`,
            updatedAt: now,
          },
          actor: DELIVERY_ACTOR,
          source: DELIVERY_SOURCE,
          returning: ['attempts'],
        })
      ).rows;
  const row = reclaimed[0];
  if (!row) return null;
  if (typeof row.attempts !== 'number') {
    throw new Error(
      `rocketchat.question-delivery: the claim on question ${owed.questionId} round ${owed.round} returned a row with no attempt count`,
    );
  }
  return row.attempts;
}

export function roundOf(owed: OwedRound) {
  return and(
    eq(rocketchatQuestionDeliveries.questionId, owed.questionId),
    eq(rocketchatQuestionDeliveries.round, owed.round),
  );
}

export async function settle(
  owed: OwedRound,
  patch: { status: 'delivered' | 'undeliverable'; lastError?: string | null },
  now: Date,
): Promise<void> {
  await transition(db, QUESTION_DELIVERY_MACHINE, {
    to: patch.status,
    from: 'claimed',
    where: roundOf(owed),
    set: {
      lastError: patch.lastError ?? null,
      nextAttemptAt:
        patch.status === 'delivered' ? null : new Date(now.getTime() + UNBOUND_RETRY_MS),
      updatedAt: now,
    },
    reason: patch.lastError ?? null,
    actor: DELIVERY_ACTOR,
    source: DELIVERY_SOURCE,
    returning: ['id'],
  });
}
