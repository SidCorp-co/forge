interface Subscriber {
  send(data: string): void;
  readyState: number;
}

interface PublishEnvelope {
  event: string;
  data: unknown;
}

export const projectRoom = (projectId: string): string => `project:${projectId}`;
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
export const runnerRoom = (runnerId: string): string => `runner:${runnerId}`;

const OPEN = 1;

/** How far back a room's frames are kept for a socket that subscribes late. */
export const REPLAY_WINDOW_MS = 10 * 60_000;
/** The most frames one room keeps; past it the oldest go, and a replay reaching them is incomplete. */
export const REPLAY_FRAMES_PER_ROOM = 200;

/** Every this many frames, the rooms that went quiet are pruned too. */
const SWEEP_EVERY = 500;

interface Kept {
  at: number;
  payload: string;
}

interface History {
  frames: Kept[];
  /** When the newest frame this room dropped for space was sent; a replay from before it is incomplete. */
  droppedThrough: number;
}

/** What a late subscriber was sent: every frame since the time it asked for, or not all of them. */
export interface Replay {
  frames: number;
  complete: boolean;
}

export class RoomManager {
  private readonly rooms = new Map<string, Set<Subscriber>>();
  private readonly memberships = new WeakMap<Subscriber, Set<string>>();
  private readonly history = new Map<string, History>();
  private readonly startedAt: number;
  private publishedSinceSweep = 0;

  /** `now` is the clock frames are stamped and kept by; a test hands its own. */
  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  subscribe(sub: Subscriber, room: string): void {
    let set = this.rooms.get(room);
    if (!set) {
      set = new Set();
      this.rooms.set(room, set);
    }
    set.add(sub);

    let rooms = this.memberships.get(sub);
    if (!rooms) {
      rooms = new Set();
      this.memberships.set(sub, rooms);
    }
    rooms.add(room);
  }

  unsubscribe(sub: Subscriber, room: string): void {
    const set = this.rooms.get(room);
    if (set) {
      set.delete(sub);
      if (set.size === 0) this.rooms.delete(room);
    }
    this.memberships.get(sub)?.delete(room);
  }

  removeAll(sub: Subscriber): void {
    const rooms = this.memberships.get(sub);
    if (!rooms) return;
    for (const room of rooms) {
      const set = this.rooms.get(room);
      if (!set) continue;
      set.delete(sub);
      if (set.size === 0) this.rooms.delete(room);
    }
    this.memberships.delete(sub);
  }

  publish(room: string, envelope: PublishEnvelope): number {
    const at = this.now();
    const payload = JSON.stringify({
      event: envelope.event,
      data: envelope.data,
      timestamp: new Date(at).toISOString(),
    });
    this.keep(room, at, payload);
    const set = this.rooms.get(room);
    if (!set || set.size === 0) return 0;
    let delivered = 0;
    for (const sub of set) {
      if (sub.readyState !== OPEN) continue;
      sub.send(payload);
      delivered++;
    }
    return delivered;
  }

  roomSize(room: string): number {
    return this.rooms.get(room)?.size ?? 0;
  }

  /**
   * Sends `sub` every frame `room` published in the last `ageMs`, oldest first, so a socket that opened
   * or subscribed after a page read its data hears what changed in between and nothing more. It is
   * complete only where nothing in that span was dropped: not before this process started, and not
   * past the room's window or frame bound.
   */
  replay(sub: Subscriber, room: string, ageMs: number): Replay {
    const now = this.now();
    const since = now - ageMs;
    this.prune(room, now);
    const kept = this.history.get(room);
    const complete =
      since >= this.startedAt &&
      since >= now - REPLAY_WINDOW_MS &&
      (kept?.droppedThrough ?? 0) < since;
    let frames = 0;
    for (const frame of kept?.frames ?? []) {
      if (frame.at < since || sub.readyState !== OPEN) continue;
      sub.send(frame.payload);
      frames++;
    }
    return { frames, complete };
  }

  private keep(room: string, at: number, payload: string): void {
    let kept = this.history.get(room);
    if (!kept) {
      kept = { frames: [], droppedThrough: 0 };
      this.history.set(room, kept);
    }
    kept.frames.push({ at, payload });
    while (kept.frames.length > REPLAY_FRAMES_PER_ROOM) {
      const dropped = kept.frames.shift();
      if (dropped) kept.droppedThrough = dropped.at;
    }
    if (++this.publishedSinceSweep < SWEEP_EVERY) {
      this.prune(room, at);
      return;
    }
    this.publishedSinceSweep = 0;
    for (const quiet of [...this.history.keys()]) this.prune(quiet, at);
  }

  private prune(room: string, now: number): void {
    const kept = this.history.get(room);
    if (!kept) return;
    const horizon = now - REPLAY_WINDOW_MS;
    while (kept.frames[0] && kept.frames[0].at < horizon) kept.frames.shift();
    if (kept.frames.length === 0 && kept.droppedThrough < horizon) this.history.delete(room);
  }
}

export const roomManager = new RoomManager();
