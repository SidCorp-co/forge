// The ask-a-box exchange the checkout reads and the box acts share: a frame sent on the box's socket
// carrying a fresh requestId, a timer that settles the read as unanswered, and the device route's
// answer matched back to the box and project it was asked of. What a read asks and how it judges the
// answer stays in its own module; this holds only the wait.

import { randomUUID } from 'node:crypto';

interface Pending<E> {
  deviceId: string;
  projectId: string;
  entry: E;
  timer: ReturnType<typeof setTimeout>;
  /** Set while the frame waits for its box to come back; cleared once a socket took it. */
  retry: ReturnType<typeof setTimeout> | null;
}

/** One frame to one box: `data` gains the `requestId` the answer comes back under. */
export interface BoxFrame<R> {
  deviceId: string;
  projectId: string;
  event: string;
  data: Record<string, unknown>;
  timeoutMs: number;
  send(deviceId: string, envelope: { event: string; data: unknown }): number;
  settle(read: R): void;
  /** What the read is when the box never answers; runs once, when the wait lapses. */
  unanswered(): R;
  /** What the read is when the box dropped before the frame was taken, and did not come back in time. */
  disconnected(): R;
  /**
   * Where set, a frame no socket took is offered again every this many ms until one takes it or
   * `timeoutMs` lapses, so a box reconnecting inside the wait is still asked; unset, it settles
   * `disconnected` at once. A frame a socket took is never sent again.
   */
  awaitReconnectEveryMs?: number;
}

/** The reads asked and not yet answered, for one kind of read. */
export function boxAsks<E>() {
  const pending = new Map<string, Pending<E>>();
  return {
    /** Send the frame and wait: `entry` is handed back by `take` for the matching answer. */
    ask<R>(entry: E, frame: BoxFrame<R>): void {
      const requestId = randomUUID();
      let taken = false;
      const timer = setTimeout(() => {
        if (waiting.retry) clearTimeout(waiting.retry);
        pending.delete(requestId);
        frame.settle(taken ? frame.unanswered() : frame.disconnected());
      }, frame.timeoutMs);
      const waiting: Pending<E> = {
        deviceId: frame.deviceId,
        projectId: frame.projectId,
        entry,
        timer,
        retry: null,
      };
      pending.set(requestId, waiting);
      const offer = (): void => {
        waiting.retry = null;
        if (pending.get(requestId) !== waiting) return;
        const took = frame.send(frame.deviceId, {
          event: frame.event,
          data: { requestId, ...frame.data },
        });
        if (took > 0) {
          taken = true;
          return;
        }
        if (frame.awaitReconnectEveryMs !== undefined) {
          waiting.retry = setTimeout(offer, frame.awaitReconnectEveryMs);
          return;
        }
        clearTimeout(timer);
        pending.delete(requestId);
        frame.settle(frame.disconnected());
      };
      offer();
    },
    /** The entry `requestId` was asked of `deviceId` for `projectId`, now no longer waited on; none if nobody asked that box. */
    take(requestId: string, deviceId: string, projectId: string): E | undefined {
      const found = pending.get(requestId);
      if (!found || found.deviceId !== deviceId || found.projectId !== projectId) return undefined;
      pending.delete(requestId);
      clearTimeout(found.timer);
      if (found.retry) clearTimeout(found.retry);
      return found.entry;
    },
  };
}
