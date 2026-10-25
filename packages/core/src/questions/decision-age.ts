// How long an owed round has waited (REQ-68 BC-8). Day 3 reminds the people who owe it. Day 14 has
// the agent propose deferring or dropping the requirement it holds up. Each stamp counts only for the
// round asked before it, so a new round starts its own clock and nothing is reset.

import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentQuestions } from '../db/schema-questions.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';

/** The day an owed round reminds the people who owe it. */
export const REMIND_AFTER_DAYS = 3;
/** The day the agent proposes deferring or dropping the requirement a round holds up. */
export const ESCALATE_AFTER_DAYS = 14;

export type DecisionAgeStamp = 'remindedAt' | 'escalatedAt';

/** When the current round was asked: its own `askedAt`, else when the question was written. */
const roundAskedAt = sql`coalesce((${agentQuestions.steps} -> -1 ->> 'askedAt')::timestamptz, ${agentQuestions.createdAt})`;

/** The requirement a round holds up: the one it is asked of, else the one it is about. */
export const requirementOf = sql`coalesce(${agentQuestions.requirementId},
  case when ${agentQuestions.about} ->> 'kind' = 'requirement'
    then (${agentQuestions.about} ->> 'requirementId')::uuid end)`;

export interface AgedRound {
  id: string;
  projectId: string;
  askedBy: string | null;
  prompt: string;
  round: number;
  askedAt: string;
  /** The item it stands on or names, by key, for the notice; null where it names none. */
  itemKey: string | null;
  issueId: string | null;
  /** The requirement it holds up, with the status deciding which proposals apply; null where none. */
  requirement: { key: string; status: string } | null;
}

/**
 * Every open round a person owes, asked at or before `cutoff`, not yet stamped `stamp` for this
 * round. Oldest first.
 */
export async function agedRounds(stamp: DecisionAgeStamp, cutoff: Date): Promise<AgedRound[]> {
  const column = agentQuestions[stamp];
  const rows = await db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      askedBy: agentQuestions.askedBy,
      issueId: agentQuestions.issueId,
      prompt: sql<string>`${agentQuestions.steps} -> -1 ->> 'prompt'`,
      round: sql<number>`(${agentQuestions.steps} -> -1 ->> 'round')::int`,
      askedAt: sql<string>`${roundAskedAt}`,
      itemKey: sql<string | null>`coalesce(
        (select 'ISS-' || i.iss_seq from issues i where i.id = ${agentQuestions.issueId}),
        (select 'REQ-' || r.req_seq from requirements r where r.id = ${requirementOf}),
        (select 'FB-' || f.fb_seq from feedback f where f.id = coalesce(${agentQuestions.feedbackId},
          case when ${agentQuestions.about} ->> 'kind' = 'feedback'
            then (${agentQuestions.about} ->> 'feedbackId')::uuid end)))`,
      requirementKey: sql<
        string | null
      >`(select 'REQ-' || r.req_seq from requirements r where r.id = ${requirementOf})`,
      requirementStatus: sql<
        string | null
      >`(select r.status from requirements r where r.id = ${requirementOf})`,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
        sql`${roundAskedAt} <= ${sqlTimestamp(cutoff)}`,
        or(isNull(column), sql`${column} < ${roundAskedAt}`),
      ),
    )
    .orderBy(roundAskedAt);
  return rows.map(({ requirementKey, requirementStatus, askedAt, ...r }) => ({
    ...r,
    askedAt: new Date(askedAt).toISOString(),
    requirement:
      requirementKey && requirementStatus
        ? { key: requirementKey, status: requirementStatus }
        : null,
  }));
}

/**
 * Stamp these rounds, each only while still open and unstamped for its round. Returns the ids
 * stamped, so a sweep running beside another never stamps twice.
 */
export async function stampAgedRounds(
  stamp: DecisionAgeStamp,
  ids: readonly string[],
  now: Date,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const column = agentQuestions[stamp];
  const rows = await db
    .update(agentQuestions)
    .set({ [stamp]: now })
    .where(
      and(
        inArray(agentQuestions.id, [...ids]),
        eq(agentQuestions.status, 'open'),
        or(isNull(column), sql`${column} < ${roundAskedAt}`),
      ),
    )
    .returning({ id: agentQuestions.id });
  return rows.map((r) => r.id);
}

/**
 * What the agent may propose for a requirement a round has held up 14 days: a defer and a drop, each
 * only where the requirement machine has that edge from its status. Empty means nothing to propose.
 */
export function escalationActs(status: string): Array<'requirement.defer' | 'requirement.drop'> {
  const to = (target: string) =>
    REQUIREMENT_MACHINE.edges.some((e) => e.from === status && e.to === target);
  return [
    ...(to('deferred') ? (['requirement.defer'] as const) : []),
    ...(to('dropped') ? (['requirement.drop'] as const) : []),
  ];
}
