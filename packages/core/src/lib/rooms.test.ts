// A socket that subscribes after its page read the data hears the frames it missed, and is told
// plainly when the server no longer holds all of them.
import { describe, expect, it } from 'vitest';
import { REPLAY_FRAMES_PER_ROOM, REPLAY_WINDOW_MS, RoomManager } from './rooms.js';

function socket() {
  const sent: { event: string; data: unknown }[] = [];
  return { sent, readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
}

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('a late subscriber', () => {
  it('is sent the frames of the span it asked for, oldest first, and nothing older', () => {
    const c = clock();
    const rooms = new RoomManager(c.now);
    c.t += 60_000;
    rooms.publish('project:a', { event: 'too-old', data: 1 });
    c.t += 10_000;
    rooms.publish('project:a', { event: 'first', data: 2 });
    c.t += 1_000;
    rooms.publish('project:a', { event: 'second', data: 3 });
    rooms.publish('project:b', { event: 'other-room', data: 4 });
    c.t += 1_000;
    const sub = socket();
    rooms.subscribe(sub, 'project:a');
    expect(rooms.replay(sub, 'project:a', 5_000)).toEqual({ frames: 2, complete: true });
    expect(sub.sent.map((f) => f.event)).toEqual(['first', 'second']);
  });

  it('hears nothing, completely, when nothing moved in its span', () => {
    const c = clock();
    const rooms = new RoomManager(c.now);
    c.t += 30_000;
    const sub = socket();
    expect(rooms.replay(sub, 'user:u', 10_000)).toEqual({ frames: 0, complete: true });
    expect(sub.sent).toEqual([]);
  });

  it('is told the replay is incomplete when its span reaches before this process started', () => {
    const c = clock();
    const rooms = new RoomManager(c.now);
    c.t += 1_000;
    expect(rooms.replay(socket(), 'project:a', 5_000).complete).toBe(false);
  });

  it('is told the replay is incomplete when its span is older than the window kept', () => {
    const c = clock();
    const rooms = new RoomManager(c.now);
    c.t += REPLAY_WINDOW_MS * 2;
    expect(rooms.replay(socket(), 'project:a', REPLAY_WINDOW_MS + 1).complete).toBe(false);
    expect(rooms.replay(socket(), 'project:a', REPLAY_WINDOW_MS).complete).toBe(true);
  });

  it('is told the replay is incomplete when the room dropped frames of its span for space', () => {
    const c = clock();
    const rooms = new RoomManager(c.now);
    c.t += 60_000;
    for (let i = 0; i <= REPLAY_FRAMES_PER_ROOM; i++) {
      c.t += 10;
      rooms.publish('project:a', { event: `f${i}`, data: i });
    }
    const sub = socket();
    const replay = rooms.replay(sub, 'project:a', 30_000);
    expect(replay).toEqual({ frames: REPLAY_FRAMES_PER_ROOM, complete: false });
    expect(sub.sent[0]?.event).toBe('f1');
    expect(rooms.replay(socket(), 'project:a', 1_000).complete).toBe(true);
  });
});
