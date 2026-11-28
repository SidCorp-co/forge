// What a room's session read of live state, and what it handed on, by turn (ISS-1354, ISS-1416). A
// read's result sits in a resident session's context undated, so an earlier turn's read of a setting
// reads as current there: FB-824's "not enabled yet" and "still off" were stated from reads a turn or a day
// old. Core names, as it hands a turn over, when the session last read, so reading again is the
// natural move; the reply audit (`reply-audit/audit.ts`) reads the same acts after the reply.

import { and, eq, inArray, max, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';

/**
 * The acts that read what an environment holds now (ISS-1354): a declared read or a run (recorded
 * `diagnose`), a release, issue or deployment read, and a look at a screen.
 */
const STATE_READ_TOOLS = ['releases', 'issues', 'deployment', 'look'] as const;
export const stateRead = or(
  eq(supportActions.kind, 'diagnose'),
  and(eq(supportActions.kind, 'operation'), inArray(supportActions.tool, [...STATE_READ_TOOLS])),
);

/** Whether an act of that kind and tool is one `stateRead` matches. */
export const isStateRead = (kind: string, tool: string | null): boolean =>
  kind === 'diagnose' ||
  (kind === 'operation' && (STATE_READ_TOOLS as readonly (string | null)[]).includes(tool));

/**
 * The acts that landed a need somewhere else (ISS-1416): a raise or a route (`routed`), an
 * announcement, a filing, and an ask of a master or of the owner. A refused one records none of these.
 */
export const handedOn = or(
  inArray(supportActions.kind, ['routed', 'announced', 'feedback_recorded']),
  and(
    eq(supportActions.kind, 'operation'),
    inArray(supportActions.tool, ['ask_master', 'raise_owed']),
  ),
);

/** The line a turn opens with where the session read live state in an earlier turn. */
export function earlierReadLine(lastAt: Date, now: Date): string {
  return `This turn opened at ${now.toISOString()}. Your last read of live state (a read, run, issue, release, deployment or look) was at ${lastAt.toISOString()}, in an earlier turn: it is not current. Read again before you say a setting is on or off, or state an account's or a record's status, that a deploy is running or done, which version a site serves, or that the product works; where you cannot, say you have not checked it now, never the earlier value. A check handed to you in this turn is yours to state, with when it was made; never say who made it.`;
}

/** That line for the session's next turn, or null where it never read live state. */
export async function earlierReadNote(sessionId: string, now = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ at: max(supportActions.createdAt) })
    .from(supportActions)
    .where(and(eq(supportActions.sessionId, sessionId), stateRead));
  return row?.at ? earlierReadLine(row.at, now) : null;
}
