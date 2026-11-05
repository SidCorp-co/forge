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

import { logger } from '../lib/logger.js';
import { giveBackFailed, toldFailed } from './delivery.js';
import { deliverWaiting } from './dispatch.js';
import { tellLastResort } from './last-resort.js';
import { type ActionRow, insertAction, type RoomRow } from './store.js';

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
 * Record each thread of `taken` as left without an answer, with `reason`, and tell it so in core's
 * last-resort line, once per wait: a message some failure was already reported for is not reported
 * again, and a thread told while it still waits is recorded, not told twice.
 */
export async function tellUnanswered(
  room: RoomRow,
  taken: readonly ActionRow[],
  reason: string,
): Promise<void> {
  const told = await toldFailed(
    room.id,
    taken.map((m) => m.id),
  );
  const left = taken.filter((m) => !told.has(m.id));
  const threads = new Map(left.map((m) => [m.thread, m] as const));
  for (const [thread, first] of threads) {
    // a scheduled check or a release note is no member's thread: its failure is recorded, and
    // nothing is posted (BC-13, ISS-854)
    const said = await tellLastResort(room, thread, 'turn_failed');
    const posted = said.posted ? said : null;
    await insertAction({
      roomId: room.id,
      projectId: room.projectId,
      conversationId: posted?.conversationId ?? first.conversationId,
      thread,
      kind: 'refused',
      actorKind: 'core',
      tool: 'turn_failed',
      output: {
        reason,
        messages: left.filter((m) => m.thread === thread).map((m) => m.id),
        posted: Boolean(posted),
      },
      externalId: posted?.messageId ?? null,
    });
  }
}
