// The rule: an ephemeral frame never becomes an outbox row. A frame is ephemeral when it records no
// state change of its own: either the next frame of the same live turn supersedes it, or it only
// announces rows already stored that a reader refetches. Today that is a conversation's turn
// progress (every 120 ms per live turn), a session's turn-appended pings while a reply streams, and
// a job's live log lines (stored in job_events before they are announced). The outbox carries
// durable state changes; written there, these would add a pipeline_outbox row and a pg-boss job
// several times a second per live turn. Losing one costs a reader nothing it cannot refetch.
//
// The WebSocket door provides the publisher at boot, so no module outside ws/ names a room.

/** Who an ephemeral frame is for: a project's open views, a box, and named people. */
export interface EphemeralTarget {
  projectId?: string | null;
  deviceId?: string | null;
  userIds?: readonly string[];
}

export interface EphemeralFrame {
  event: string;
  data: unknown;
}

type EphemeralPublisher = (target: EphemeralTarget, frame: EphemeralFrame) => void;

let publisher: EphemeralPublisher | null = null;

export function provideEphemeralPublisher(fn: EphemeralPublisher): void {
  publisher = fn;
}

/** Hand an ephemeral frame to the sockets reading its target now; nothing is written down. */
export function publishEphemeral(target: EphemeralTarget, frame: EphemeralFrame): void {
  if (!publisher) {
    throw new Error(
      'ephemeral frames: no publisher was provided; the process entry calls provideEphemeralPublisher(publishEphemeralFrame) from ws/ before it serves',
    );
  }
  publisher(target, frame);
}
