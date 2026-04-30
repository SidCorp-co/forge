export interface Subscriber {
  send(data: string): void;
  readyState: number;
}

export interface PublishEnvelope {
  event: string;
  data: unknown;
}

export const projectRoom = (projectId: string): string => `project:${projectId}`;
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
export const runnerRoom = (runnerId: string): string => `runner:${runnerId}`;
// Single shared room for cross-tenant broadcasts (e.g. global skill updates
// from `seedBuiltinSkills`). Any authenticated principal may subscribe; no
// project membership is required. Distinct from the prefix-based rooms above
// so it never collides with a UUID-derived key.
export const GLOBAL_ROOM = 'global';
export const globalRoom = (): string => GLOBAL_ROOM;

const OPEN = 1;

export class RoomManager {
  private readonly rooms = new Map<string, Set<Subscriber>>();
  private readonly memberships = new WeakMap<Subscriber, Set<string>>();

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
    const set = this.rooms.get(room);
    if (!set || set.size === 0) return 0;
    const payload = JSON.stringify({
      event: envelope.event,
      data: envelope.data,
      timestamp: new Date().toISOString(),
    });
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
}
