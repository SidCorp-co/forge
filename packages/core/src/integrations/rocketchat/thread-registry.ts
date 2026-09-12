// Which conversation a Rocket.Chat thread belongs to, and the one place that answers it.
//
// ISS-978 opened threads for a parked question. ISS-981 opens them for an
// issue's comments too, in the same room, and the two must never be confused:
// Rocket.Chat threads do not nest, so a reply carries nothing but its `tmid`
// and the subject has to be decidable from that alone.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { rocketchatThreads } from '../../db/schema-rocketchat.js';

export type ThreadSubject =
  | { kind: 'question'; questionId: string }
  | { kind: 'issue'; issueId: string; retired: boolean };

export interface ThreadRef {
  connectionId: string;
  rid: string;
  tmid: string;
}

// cm:guard the lookup is by (connection, room, thread) and nothing else — the same triple the unique index holds — because a thread we do not own must be indistinguishable here from one that does not exist, and the caller falls through to the conversation handler on null (ISS-978 criterion 21).
// cm:guard a RETIRED issue thread still resolves, and the `retired` flag rather than a null is what lets the caller refuse it by name: dropping the row on retirement would send a reply left there to the conversation handler, which answers a person with a model in a thread that was theirs (ISS-981 criteria 35, 36).
export async function subjectForThread(ref: ThreadRef): Promise<ThreadSubject | null> {
  const [row] = await db
    .select({
      questionId: rocketchatThreads.questionId,
      issueId: rocketchatThreads.issueId,
      retiredAt: rocketchatThreads.retiredAt,
    })
    .from(rocketchatThreads)
    .where(
      and(
        eq(rocketchatThreads.connectionId, ref.connectionId),
        eq(rocketchatThreads.rid, ref.rid),
        eq(rocketchatThreads.tmid, ref.tmid),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.questionId) return { kind: 'question', questionId: row.questionId };
  if (row.issueId) {
    return { kind: 'issue', issueId: row.issueId, retired: row.retiredAt !== null };
  }
  return null;
}

/** The thread this question was first asked in, or null when it has none yet. */
export async function threadForQuestion(questionId: string): Promise<string | null> {
  const [row] = await db
    .select({ tmid: rocketchatThreads.tmid })
    .from(rocketchatThreads)
    .where(eq(rocketchatThreads.questionId, questionId))
    .limit(1);
  return row?.tmid ?? null;
}

export interface IssueThread {
  connectionId: string;
  rid: string;
  tmid: string;
}

/** The live thread this issue's comments go to, or null when none is open. */
// cm:guard live rows only — a retired thread points into a room the project is no longer bound to, and posting a comment there sends it to people who stopped following this issue when the binding moved (ISS-981 criterion 32).
export async function liveThreadForIssue(issueId: string): Promise<IssueThread | null> {
  const [row] = await db
    .select({
      connectionId: rocketchatThreads.connectionId,
      rid: rocketchatThreads.rid,
      tmid: rocketchatThreads.tmid,
    })
    .from(rocketchatThreads)
    .where(and(eq(rocketchatThreads.issueId, issueId), isNull(rocketchatThreads.retiredAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Register the thread a subject was opened in. A second registration for the
 * same triple is the same thread, and is left alone.
 */
// cm:guard `onConflictDoNothing` with NO target, which is what a rolled-back binary also writes: the conflict may be the room triple or the subject's own unique, and naming one of them would let the other raise instead of being absorbed.
export async function registerThread(
  subject: { questionId: string } | { issueId: string },
  ref: ThreadRef,
  tx: Tx = db,
): Promise<void> {
  await tx
    .insert(rocketchatThreads)
    .values({ ...subject, ...ref })
    .onConflictDoNothing();
}

/**
 * Retire this issue's live thread, so the next comment opens a new one.
 */
// cm:guard retirement is a timestamp and never a delete, and the partial unique is what makes the replacement registrable: the retired row keeps holding its room triple so a reply left there still resolves and is refused by name (ISS-981 criteria 35, 36).
export async function retireIssueThread(issueId: string): Promise<void> {
  await db
    .update(rocketchatThreads)
    .set({ retiredAt: sql`now()` })
    .where(and(eq(rocketchatThreads.issueId, issueId), isNull(rocketchatThreads.retiredAt)));
}
