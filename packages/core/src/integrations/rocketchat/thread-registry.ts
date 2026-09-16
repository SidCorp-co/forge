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
 * Register the thread a subject was opened in. A second registration for the
 * same triple is the same thread, and is left alone.
 */
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
