// A support turn that fails on Forge's own side is tried again before anyone is told (ISS-977). A
// crash, a runner restart, a refused transcript batch, a dispatch that never reached the box, a
// provider error or a timeout each leaves the messages the turn took unanswered; Forge holds them,
// so they are given back to wait for the next turn, which takes them after a short back-off. Each
// try lands on the room's history with its cause. Only when the tries run out is the thread told,
// in core's line saying the assistant answers when it can (`last-resort.ts`), and the messages stay
// queued all the same: they go with the room's next turn, or on the slow back-off below.
//
// Replaces the rule that a failed turn's messages stayed delivered and were never handed again,
// and the lost turn's one hand-on (ISS-850's `redelivered` marker), with one count for every cause.
//
// A held message has an age bound (ISS-1105): one that waited past `HELD_MESSAGE_MAX_AGE_MS` is
// dropped with a record on the room and its thread is never told. A failure is told to the room
// once, in one line at its top level, and only where a message within the bound still waits on an
// answer; it replaces the rule that told each waiting thread in a post of its own, which posted
// into 19 threads of 12-hour-old chatter at once in epod's sid-catalog.

import { logger } from '../lib/logger.js';
import { dropWaitingBefore, giveBackFailed, toldFailed } from './delivery.js';
import { deliverWaiting } from './dispatch.js';
import { tellRoomLastResort } from './last-resort.js';
import { isCoreThread } from './rules.js';
import { type ActionRow, insertAction, type RoomRow } from './store.js';
import { TOP_LEVEL } from './thread.js';

/**
 * How long a member's message may wait for an answer before core stops holding it (ISS-1105): two
 * hours. Past it, an answer or a failed-turn line reads to the room as the assistant waking on an
 * old thread (epod's sid-catalog had 19 threads of room chatter held 12 hours behind a broken
 * session, each told at 04:13 local), and whoever asked has moved on or asked a person. Two hours
 * covers a box restart, a long turn and every retry above many times over, so a message a working
 * room would still answer is not dropped.
 */
export const HELD_MESSAGE_MAX_AGE_MS = 2 * 60 * 60_000;

const HELD_TOO_LONG = `it waited more than ${HELD_MESSAGE_MAX_AGE_MS / 3_600_000} hours with no turn answering it`;

/** Whether `m` waited past the bound. */
const heldTooLong = (m: Pick<ActionRow, 'createdAt'>, now: Date) =>
  now.getTime() - m.createdAt.getTime() > HELD_MESSAGE_MAX_AGE_MS;

/**
 * Drop each message `room` held past the bound, with one record on the room naming who wrote each,
 * when, and why; no turn takes it and its thread is never told. Answers how many were dropped.
 */
export async function dropHeldTooLong(room: RoomRow, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HELD_MESSAGE_MAX_AGE_MS);
  const dropped = await dropWaitingBefore(room.id, cutoff, now, HELD_TOO_LONG);
  if (dropped.length === 0) return 0;
  await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread: TOP_LEVEL,
    kind: 'refused',
    actorKind: 'core',
    tool: 'held_too_long',
    output: {
      why: HELD_TOO_LONG,
      maxAgeMs: HELD_MESSAGE_MAX_AGE_MS,
      messages: dropped.map((m) => ({
        id: m.id,
        thread: m.thread,
        who: m.actorLabel ?? m.actorKey,
        at: m.createdAt.toISOString(),
      })),
    },
  });
  logger.warn(
    { roomId: room.id, dropped: dropped.length },
    'support: messages held past the age bound were dropped, and no thread was told',
  );
  return dropped.length;
}

/**
 * Whether a message the room handed its session waits on an answer: one in a member's thread that
 * names nobody but the bot. A message naming someone else is the room's own talk (REQ-77 BC-6),
 * and in a room answering mentions only the messages that name the bot or carry on its thread were
 * handed at all, so what is left is a mention or a question put to the assistant.
 */
function waitsOnAnswer(m: Pick<ActionRow, 'thread' | 'input'>): boolean {
  if (m.thread === TOP_LEVEL || isCoreThread(m.thread)) return false;
  return (m.input as { addressed?: unknown } | null)?.addressed !== 'others';
}

/**
 * How many turns may take a message before its thread is told. The first retry covers a one-off
 * fault (the turn a restart raced, a refused transcript batch, a socket that dropped mid hand-over);
 * the second covers a box that is back within the 20 s after it. A third failure in a row is not a
 * one-off, and the person hears within about half a minute instead of waiting on silence.
 */
export const MAX_TRIES = 3;

/**
 * The back-off after each failed try: 5 s after the first, 20 s after the second, and, once the
 * tries ran out, 10 minutes between the slow re-offers that keep a held message moving while nothing
 * else in the room starts a turn.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 10 * 60_000];

/**
 * The turn that took `taken` ended without answering them, for `cause` on Forge's side. Each message
 * is given back with its try counted, each thread records the try and its cause, and a thread whose
 * message spent its last try is told, once per wait. `at`, where given, is the hand-over the
 * messages were claimed at: only those still read delivered then are counted.
 */
export async function retryOrTell(
  room: RoomRow,
  taken: readonly ActionRow[],
  cause: string,
  opts: { at?: Date; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const back = await giveBackFailed(
    taken.map((m) => m.id),
    cause,
    now,
    RETRY_DELAYS_MS,
    opts.at,
  );
  if (back.length === 0) return;
  const threads = new Map<string, typeof back>();
  for (const m of back) threads.set(m.thread, [...(threads.get(m.thread) ?? []), m]);
  for (const [thread, msgs] of threads) {
    const first = taken.find((m) => m.thread === thread);
    const tries = Math.max(...msgs.map((m) => m.tries));
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: first?.conversationId ?? null,
      thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'turn_retry',
      output: {
        cause,
        try: tries,
        of: MAX_TRIES,
        messages: msgs.map((m) => m.id),
        retryAt: msgs[0]?.retryAt ?? null,
      },
    });
  }
  const spent = new Set(back.filter((m) => m.tries >= MAX_TRIES).map((m) => m.id));
  await tellUnanswered(
    room,
    taken.filter((m) => spent.has(m.id)),
    `${MAX_TRIES} tries ran out; the last: ${cause}`,
  );
  // the drain re-offers a room whose back-off ended; this wakes it on time without waiting a tick
  const soonest = Math.min(
    ...back.map((m) => RETRY_DELAYS_MS[Math.min(m.tries, RETRY_DELAYS_MS.length) - 1] ?? 0),
  );
  setTimeout(() => {
    void deliverWaiting(room.id).catch((err) =>
      logger.error({ err, roomId: room.id }, 'support: re-offering a failed turn failed'),
    );
  }, soonest).unref();
}

/**
 * Record each thread of `taken` as left without an answer, with `reason`, and tell the room once
 * (ISS-1105): one line at its top level through core's last-resort path, where a message within the
 * bound still waits on an answer, never a post in each thread. A message held past the bound is not
 * reported here (`dropHeldTooLong` records it), one some failure was already reported for is not
 * reported again, and a room told while it still waits is not told twice.
 */
export async function tellUnanswered(
  room: RoomRow,
  taken: readonly ActionRow[],
  reason: string,
  now: Date = new Date(),
): Promise<void> {
  const told = await toldFailed(
    room.id,
    taken.map((m) => m.id),
  );
  const left = taken.filter((m) => !told.has(m.id) && !heldTooLong(m, now));
  if (left.length === 0) return;
  const waiting = left.filter(waitsOnAnswer);
  const said =
    waiting.length > 0
      ? await tellRoomLastResort(
          room,
          waiting.map((m) => String((m.input as { text?: unknown } | null)?.text ?? '')),
        )
      : null;
  const posted = said?.posted ? said : null;
  const threads = new Map(left.map((m) => [m.thread, m] as const));
  for (const [thread, first] of threads) {
    const messages = left.filter((m) => m.thread === thread);
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: first.conversationId,
      thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'turn_failed',
      output: {
        reason,
        messages: messages.map((m) => m.id),
        waitsOnAnswer: messages.some(waitsOnAnswer),
        // the room's one line, where this call posted it; the thread itself is told nothing
        posted: Boolean(posted),
        roomLine: posted?.messageId ?? null,
      },
    });
  }
}
