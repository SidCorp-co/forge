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

/** The thread this question was first asked in, whole, or null when it has none yet. */
// cm:guard the WHOLE triple and never the `tmid` alone, which is what this answered until ISS-1091: a follow-up round is posted into the room its thread lives in, and a caller that had only the `tmid` had to pair it with a room it resolved for itself — the project's, which since ISS-1091 may not be the room the first round went to. A `tmid` from one room sent to another posts a follow-up as a fresh message in a room nobody was answering in.
// cm:guard `rcq_threads_question_idx` is UNIQUE on `question_id`, so one decision has exactly one thread and this row is the destination of every round after the first. That is why a later round whose destination would differ is refused by name rather than opening a second thread.
export async function questionThread(questionId: string): Promise<ThreadRef | null> {
  const [row] = await db
    .select({
      connectionId: rocketchatThreads.connectionId,
      rid: rocketchatThreads.rid,
      tmid: rocketchatThreads.tmid,
    })
    .from(rocketchatThreads)
    .where(eq(rocketchatThreads.questionId, questionId))
    .limit(1);
  return row ?? null;
}

export interface IssueThread {
  connectionId: string;
  rid: string;
  tmid: string;
}

/** The live thread this issue's comments go to, or null when none is open. */
// cm:guard live rows only — a retired thread points into a room the project is no longer bound to, and posting a comment there sends it to people who stopped following this issue when the binding moved (ISS-981 criterion 32).
export async function liveThreadForIssue(
  issueId: string,
  tx: Tx = db,
): Promise<IssueThread | null> {
  const [row] = await tx
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
 * Register the thread a subject was opened in, and answer whether it is ours.
 *
 * True means this triple now belongs to this subject — because this call
 * inserted it, or because the row already standing names the same subject.
 */
// cm:guard `onConflictDoNothing` with NO target, which is what a rolled-back binary also writes: the conflict may be the room triple or the subject's own unique, and naming one of them would let the other raise instead of being absorbed.
// cm:guard it ANSWERS rather than returning void, and a caller that can take its thread id before it posts must take the anchor through this call rather than reading ownership and then posting: two questions anchored on one message both pass a read, both post, and this insert then drops one of them in silence — after which every reply in that thread resolves to one question and the other waits for ever. The take is the atomic step; the refusal is what the loser gets (ISS-1091 criteria 20, 21).
export async function registerThread(
  subject: { questionId: string } | { issueId: string },
  ref: ThreadRef,
  tx: Tx = db,
): Promise<boolean> {
  const inserted = await tx
    .insert(rocketchatThreads)
    .values({ ...subject, ...ref })
    .onConflictDoNothing()
    .returning({ id: rocketchatThreads.id });
  if (inserted.length > 0) return true;
  const standing = await subjectForThread(ref);
  if (!standing) return false;
  return 'questionId' in subject
    ? standing.kind === 'question' && standing.questionId === subject.questionId
    : standing.kind === 'issue' && standing.issueId === subject.issueId;
}

/**
 * Give back one question's reservation on one exact thread triple.
 */
// cm:guard scoped to the QUESTION and the triple together, never to either alone: the caller releases an anchor it took moments earlier and whose post then failed, and a release scoped to the question would also drop a thread an earlier round established, while one scoped to the triple would drop another subject's. A row that is not this question's at this triple is left exactly as it is.
// cm:guard a DELETE and not a retirement, unlike an issue thread's: the row being given back stands for a message that was never posted, so there is nothing for a reply to be refused against — it is a reservation that turned out to be wrong, not a thread that ended (ISS-1091 criterion 20).
export async function releaseQuestionThread(
  questionId: string,
  ref: ThreadRef,
  tx: Tx = db,
): Promise<boolean> {
  const released = await tx
    .delete(rocketchatThreads)
    .where(
      and(
        eq(rocketchatThreads.questionId, questionId),
        eq(rocketchatThreads.connectionId, ref.connectionId),
        eq(rocketchatThreads.rid, ref.rid),
        eq(rocketchatThreads.tmid, ref.tmid),
      ),
    )
    .returning({ id: rocketchatThreads.id });
  return released.length > 0;
}

/**
 * Retire this issue's live thread, so the next comment opens a new one.
 */
// cm:guard retirement is a timestamp and never a delete, and the partial unique is what makes the replacement registrable: the retired row keeps holding its room triple so a reply left there still resolves and is refused by name (ISS-981 criteria 35, 36).
// cm:guard scoped to the EXACT row the caller decided about, never to the issue: two workers reading the same stale thread after a rebind would otherwise have the slower one retire the replacement the faster one just registered, leaving the issue with no live thread and its new thread's replies refused as retired (ISS-981 criterion 32).
export async function retireIssueThread(
  issueId: string,
  ref: ThreadRef,
  tx: Tx = db,
): Promise<boolean> {
  const retired = await tx
    .update(rocketchatThreads)
    .set({ retiredAt: sql`now()` })
    .where(
      and(
        eq(rocketchatThreads.issueId, issueId),
        eq(rocketchatThreads.connectionId, ref.connectionId),
        eq(rocketchatThreads.rid, ref.rid),
        eq(rocketchatThreads.tmid, ref.tmid),
        isNull(rocketchatThreads.retiredAt),
      ),
    )
    .returning({ id: rocketchatThreads.id });
  return retired.length > 0;
}
