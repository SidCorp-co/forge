// A room's daily line (ISS-1356 c4, c5; owner 2026-11-19): over a window, how many replies its agent
// posted, how many of them corrected an earlier post and how many re-asked what was already answered
// (each against the turn that posted it), how many said what a screen shows and how many of those
// carried a look, and each owner message left 30 minutes or more without an answer. Read from the
// room's own record: the reply rows (`screen-claims.ts` marks), the reply verdicts (a re-ask is a
// reply its audit failed on `used_context`, the line for what the thread already holds), and the
// member messages and answers of each thread. The daily review points its master here. It writes
// nothing and decides nothing.

import { and, eq, gte, inArray, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportActions } from '../db/schema-support.js';
import { supportReplyVerdicts } from '../db/schema-support-verdicts.js';
import { owedBy } from './question-task.js';
import type { ReplyMarks } from './screen-claims.js';
import type { RoomRow } from './store.js';
import { ANSWERED_ELSEWHERE } from './thread-requests.js';

/** How long an owner message may stand with no answer before the day names it. */
export const OWNER_ANSWER_MINUTES = 30;

/** One reply of the window, as its row holds it. */
export interface DayReply {
  thread: string;
  message: string | null;
  turn: string | null;
  at: Date;
  marks: ReplyMarks | null;
}

/** One message of the window a person wrote, and each answer posted in a thread. */
export interface DayMessage {
  thread: string;
  message: string | null;
  at: Date;
}

/** One reply the day counts against the turn that posted it. */
export interface DayTurnItem {
  thread: string;
  message: string | null;
  turn: string | null;
  words: string;
}

export interface RoomDay {
  since: string;
  until: string;
  replies: number;
  corrections: { count: number; items: DayTurnItem[] };
  reAsks: { count: number; items: DayTurnItem[] };
  screenClaims: { count: number; looked: number; unseen: DayTurnItem[] };
  /** Each owner message answered 30 minutes or more after it, or not at all by `until`. */
  ownerWaiting: Array<{
    thread: string;
    message: string | null;
    at: string;
    answeredAt: string | null;
    minutes: number;
  }>;
}

const minutesBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 60_000);

/** The day's line from its rows. */
export function roomDayOf(input: {
  since: Date;
  until: Date;
  replies: readonly DayReply[];
  /** The messages whose reply its audit failed on `used_context`. */
  reAsked: ReadonlySet<string>;
  owner: readonly DayMessage[];
  answers: readonly DayMessage[];
}): RoomDay {
  const item = (r: DayReply, words: string): DayTurnItem => ({
    thread: r.thread,
    message: r.message,
    turn: r.turn,
    words,
  });
  const corrections = input.replies.flatMap((r) =>
    r.marks?.correction ? [item(r, r.marks.correction)] : [],
  );
  const reAsks = input.replies.flatMap((r) =>
    r.message && input.reAsked.has(r.message) ? [item(r, 'used_context')] : [],
  );
  const claims = input.replies.filter((r) => r.marks?.screen);
  const unseen = claims.flatMap((r) =>
    r.marks?.screen && r.marks.screen.looks.length === 0 ? [item(r, r.marks.screen.claim)] : [],
  );
  const ownerWaiting = input.owner.flatMap((m) => {
    const answer = input.answers
      .filter((a) => a.thread === m.thread && a.at > m.at)
      .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    const end = answer && answer.at < input.until ? answer.at : input.until;
    const minutes = minutesBetween(m.at, end);
    if (minutes < OWNER_ANSWER_MINUTES) return [];
    return [
      {
        thread: m.thread,
        message: m.message,
        at: m.at.toISOString(),
        answeredAt: answer && answer.at < input.until ? answer.at.toISOString() : null,
        minutes,
      },
    ];
  });
  return {
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    replies: input.replies.length,
    corrections: { count: corrections.length, items: corrections },
    reAsks: { count: reAsks.length, items: reAsks },
    screenClaims: { count: claims.length, looked: claims.length - unseen.length, unseen },
    ownerWaiting,
  };
}

/** A thread's answer: a reply, a master's post, or a reply elsewhere naming its request. */
const ANSWER = or(
  eq(supportActions.kind, 'reply'),
  and(
    eq(supportActions.kind, 'routed'),
    inArray(supportActions.tool, ['master_post', ANSWERED_ELSEWHERE]),
  ),
);

/** The room's day over `[since, until)`, read from its record. */
export async function readRoomDay(room: RoomRow, since: Date, until: Date): Promise<RoomDay> {
  const inRoom = eq(supportActions.roomId, room.id);
  const replyRows = await db
    .select({
      thread: supportActions.thread,
      message: supportActions.externalId,
      turn: supportActions.turnId,
      at: supportActions.createdAt,
      output: supportActions.output,
    })
    .from(supportActions)
    .where(
      and(
        inRoom,
        eq(supportActions.kind, 'reply'),
        gte(supportActions.createdAt, since),
        lt(supportActions.createdAt, until),
      ),
    )
    .orderBy(supportActions.createdAt);
  const replies = replyRows.map((r) => ({ ...r, marks: (r.output as ReplyMarks | null) ?? null }));
  const audited = await db
    .select({ message: supportReplyVerdicts.message, failed: supportReplyVerdicts.failed })
    .from(supportReplyVerdicts)
    .where(eq(supportReplyVerdicts.roomId, room.id));
  const reAsked = new Set(
    audited.flatMap((v) => (v.message && v.failed.includes('used_context') ? [v.message] : [])),
  );
  const owner = await owedBy(room, room.projectId);
  const ownerRows = owner
    ? await db
        .select({
          thread: supportActions.thread,
          message: supportActions.externalId,
          at: supportActions.createdAt,
        })
        .from(supportActions)
        .where(
          and(
            inRoom,
            eq(supportActions.kind, 'message_in'),
            eq(supportActions.actorKind, 'member'),
            eq(supportActions.actorKey, owner),
            gte(supportActions.createdAt, since),
            lt(supportActions.createdAt, until),
          ),
        )
    : [];
  const threads = [...new Set(ownerRows.map((r) => r.thread))];
  const answers =
    threads.length === 0
      ? []
      : await db
          .select({
            thread: supportActions.thread,
            message: supportActions.externalId,
            at: supportActions.createdAt,
          })
          .from(supportActions)
          .where(
            and(
              inRoom,
              inArray(supportActions.thread, threads),
              ANSWER,
              gte(supportActions.createdAt, since),
            ),
          );
  return roomDayOf({ since, until, replies, reAsked, owner: ownerRows, answers });
}
