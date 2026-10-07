// The ask-a-box exchange both checkout reads share: a frame sent on the box's socket carrying a
// fresh requestId, a timer that settles the read as unanswered, and the device route's answer
// matched back to the box and project it was asked of. What a read asks and how it judges the
// answer stays in its own module; this holds only the wait.

import { randomUUID } from 'node:crypto';

interface Pending<E> {
  deviceId: string;
  projectId: string;
  entry: E;
  timer: ReturnType<typeof setTimeout>;
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
  /** What the read is when the box dropped before the frame was taken. */
  disconnected(): R;
}

/** The reads asked and not yet answered, for one kind of read. */
export function boxAsks<E>() {
  const pending = new Map<string, Pending<E>>();
  return {
    /** Send the frame and wait: `entry` is handed back by `take` for the matching answer. */
    ask<R>(entry: E, frame: BoxFrame<R>): void {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        frame.settle(frame.unanswered());
      }, frame.timeoutMs);
      pending.set(requestId, { deviceId: frame.deviceId, projectId: frame.projectId, entry, timer });
      const took = frame.send(frame.deviceId, {
        event: frame.event,
        data: { requestId, ...frame.data },
      });
      if (took === 0) {
        clearTimeout(timer);
        pending.delete(requestId);
        frame.settle(frame.disconnected());
      }
    },
    /** The entry `requestId` was asked of `deviceId` for `projectId`, now no longer waited on; none if nobody asked that box. */
    take(requestId: string, deviceId: string, projectId: string): E | undefined {
      const found = pending.get(requestId);
      if (!found || found.deviceId !== deviceId || found.projectId !== projectId) return undefined;
      pending.delete(requestId);
      clearTimeout(found.timer);
      return found.entry;
    },
  };
}
