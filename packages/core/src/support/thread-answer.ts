// What answers a room thread's request: one definition every reader of "was it answered" shares
// (ISS-1422) — the one-result rule (`thread-requests.ts`), one voice (`one-voice.ts`), the master's
// owed line (`dropped-unanswered.ts`) and the room's day (`room-day.ts`). Before, each kept its own
// copy, so a release-check report read as the owner's answer on the day, and a reply in another
// thread naming the request left it on the owed line.

import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { supportActions } from '../db/schema-support.js';

/** The tool a master's post is recorded under (`master-post.ts:TOOL`). */
export const MASTER_POST = 'master_post';

/**
 * The record, in a request's own thread, that a reply posted in another thread of the room answered
 * it (ISS-1314): the thread's result, though nothing was posted there.
 */
export const ANSWERED_ELSEWHERE = 'answered_elsewhere';

/** A record that is no report: a report (a release check) answers no one's request (ISS-1417). */
const notAReport = isNull(sql`${supportActions.input}->>'report'`);

/**
 * A `support_actions` row that answers its thread: the room agent's reply, a master's post that is
 * no report (one voice per thread, ISS-1243), or the record of a reply in another thread naming
 * this thread's request (ISS-1314). Rendered over the unaliased `support_actions` table.
 */
export const answersThread: SQL =
  or(
    and(eq(supportActions.kind, 'reply'), eq(supportActions.actorKind, 'session')),
    and(eq(supportActions.kind, 'routed'), eq(supportActions.tool, MASTER_POST), notAReport),
    and(eq(supportActions.kind, 'routed'), eq(supportActions.tool, ANSWERED_ELSEWHERE)),
  ) ?? sql`false`;
