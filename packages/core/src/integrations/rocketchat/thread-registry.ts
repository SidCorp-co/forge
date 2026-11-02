// Which conversation a Rocket.Chat thread belongs to, and the one place that answers it.
//
// ISS-978 opens a thread for a parked question. Rocket.Chat threads do not
// nest, so a reply carries nothing but its `tmid` and the question has to be
// decidable from that alone. A room's thread for the day's questions (ISS-873)
// holds several: a reply there goes to the newest one still open.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatDailyThreads, rocketchatThreads } from '../../db/schema-rocketchat.js';

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
    .innerJoin(agentQuestions, eq(agentQuestions.id, rocketchatThreads.questionId))
    .where(
      and(
        eq(rocketchatThreads.connectionId, ref.connectionId),
        eq(rocketchatThreads.rid, ref.rid),
        eq(rocketchatThreads.tmid, ref.tmid),
      ),
    )
    .orderBy(sql`(${agentQuestions.status} = 'open') desc`, desc(rocketchatThreads.createdAt))
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
  opts: { shared?: boolean } = {},
): Promise<boolean> {
  const inserted = await tx
    .insert(rocketchatThreads)
    .values({ ...subject, ...ref, shared: opts.shared === true })
    .onConflictDoNothing()
    .returning({ id: rocketchatThreads.id });
  if (inserted.length > 0) return true;
  const [standing] = await tx
    .select({ questionId: rocketchatThreads.questionId })
    .from(rocketchatThreads)
    .where(eq(rocketchatThreads.questionId, subject.questionId))
    .limit(1);
  if (standing) {
    const mine = await questionThread(subject.questionId);
    return (
      mine?.connectionId === ref.connectionId && mine.rid === ref.rid && mine.tmid === ref.tmid
    );
  }
  return false;
}

/** The UTC day a moment falls on, as the daily thread is keyed. */
export const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** The room's thread for this UTC day's questions, or null when none was opened yet (ISS-873). */
export async function dailyThread(
  ref: { connectionId: string; rid: string },
  day: string,
): Promise<string | null> {
  const [row] = await db
    .select({ tmid: rocketchatDailyThreads.tmid })
    .from(rocketchatDailyThreads)
    .where(
      and(
        eq(rocketchatDailyThreads.connectionId, ref.connectionId),
        eq(rocketchatDailyThreads.rid, ref.rid),
        eq(rocketchatDailyThreads.day, day),
      ),
    )
    .limit(1);
  return row?.tmid ?? null;
}

/** Keep `tmid` as the day's thread; the thread standing for the day where another took it first. */
export async function keepDailyThread(
  ref: { connectionId: string; rid: string },
  day: string,
  tmid: string,
): Promise<string> {
  await db
    .insert(rocketchatDailyThreads)
    .values({ ...ref, day, tmid })
    .onConflictDoNothing();
  const standing = await dailyThread(ref, day);
  if (!standing) {
    throw new Error(
      `rocketchat: the day's thread for room ${ref.rid} on ${day} was neither kept nor found standing`,
    );
  }
  return standing;
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
