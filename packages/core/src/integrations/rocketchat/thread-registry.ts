// Which conversation a Rocket.Chat thread belongs to, and the one place that answers it.
//
// ISS-978 opens a thread for a parked question. Rocket.Chat threads do not
// nest, so a reply carries nothing but its `tmid` and the question has to be
// decidable from that alone.

import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { rocketchatThreads } from '../../db/schema-rocketchat.js';

export type ThreadSubject = { kind: 'question'; questionId: string };

interface ThreadRef {
  connectionId: string;
  rid: string;
  tmid: string;
}

export async function subjectForThread(ref: ThreadRef): Promise<ThreadSubject | null> {
  const [row] = await db
    .select({ questionId: rocketchatThreads.questionId })
    .from(rocketchatThreads)
    .where(
      and(
        eq(rocketchatThreads.connectionId, ref.connectionId),
        eq(rocketchatThreads.rid, ref.rid),
        eq(rocketchatThreads.tmid, ref.tmid),
      ),
    )
    .limit(1);
  return row ? { kind: 'question', questionId: row.questionId } : null;
}

/** The thread this question was first asked in, whole, or null when it has none yet. */
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

/**
 * Register the thread a subject was opened in, and answer whether it is ours.
 *
 * True means this triple now belongs to this subject — because this call
 * inserted it, or because the row already standing names the same subject.
 */
export async function registerThread(
  subject: { questionId: string },
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
  return standing.questionId === subject.questionId;
}

/**
 * Give back one question's reservation on one exact thread triple.
 */
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
