import { describe, expect, it, vi } from 'vitest';
import { RoomManager, type Subscriber } from './rooms.js';

const OPEN = 1;
const CLOSED = 3;

function makeSub(readyState = OPEN): Subscriber & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), readyState };
}

describe('RoomManager', () => {
  it('subscribe + publish delivers the envelope to subscribers of that room', () => {
    const rm = new RoomManager();
    const a = makeSub();
    rm.subscribe(a, 'room1');

    const delivered = rm.publish('room1', { event: 'hello', data: { x: 1 } });

    expect(delivered).toBe(1);
    expect(a.send).toHaveBeenCalledTimes(1);
    const firstCall = a.send.mock.calls[0];
    if (!firstCall) throw new Error('expected send to be called');
    const msg = JSON.parse(firstCall[0]);
    expect(msg.event).toBe('hello');
    expect(msg.data).toEqual({ x: 1 });
    expect(typeof msg.timestamp).toBe('string');
  });

  // RFC 0002 audit finding #2 — headline test.
  it('publish to room A never delivers to subscribers joined only to room B', () => {
    const rm = new RoomManager();
    const aOnly = makeSub();
    const bOnly = makeSub();
    rm.subscribe(aOnly, 'A');
    rm.subscribe(bOnly, 'B');

    const delivered = rm.publish('A', { event: 'e', data: null });

    expect(delivered).toBe(1);
    expect(aOnly.send).toHaveBeenCalledTimes(1);
    expect(bOnly.send).not.toHaveBeenCalled();
  });

  it('a subscriber joined to both A and B receives a publish to A exactly once', () => {
    const rm = new RoomManager();
    const both = makeSub();
    rm.subscribe(both, 'A');
    rm.subscribe(both, 'B');

    rm.publish('A', { event: 'e', data: null });

    expect(both.send).toHaveBeenCalledTimes(1);
  });

  it('subscribe is idempotent (resubscribing the same socket to the same room does not duplicate)', () => {
    const rm = new RoomManager();
    const a = makeSub();
    rm.subscribe(a, 'room1');
    rm.subscribe(a, 'room1');

    const delivered = rm.publish('room1', { event: 'e', data: null });

    expect(delivered).toBe(1);
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the subscriber; subsequent publishes do not deliver', () => {
    const rm = new RoomManager();
    const a = makeSub();
    rm.subscribe(a, 'room1');
    rm.unsubscribe(a, 'room1');

    const delivered = rm.publish('room1', { event: 'e', data: null });

    expect(delivered).toBe(0);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('removeAll removes the subscriber from every room', () => {
    const rm = new RoomManager();
    const a = makeSub();
    rm.subscribe(a, 'A');
    rm.subscribe(a, 'B');
    rm.subscribe(a, 'C');

    rm.removeAll(a);

    expect(rm.publish('A', { event: 'e', data: null })).toBe(0);
    expect(rm.publish('B', { event: 'e', data: null })).toBe(0);
    expect(rm.publish('C', { event: 'e', data: null })).toBe(0);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('publish skips subscribers whose readyState is not OPEN', () => {
    const rm = new RoomManager();
    const open = makeSub(OPEN);
    const closed = makeSub(CLOSED);
    rm.subscribe(open, 'room1');
    rm.subscribe(closed, 'room1');

    const delivered = rm.publish('room1', { event: 'e', data: null });

    expect(delivered).toBe(1);
    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('publish to an unknown or empty room returns 0', () => {
    const rm = new RoomManager();
    expect(rm.publish('missing', { event: 'e', data: null })).toBe(0);

    const a = makeSub();
    rm.subscribe(a, 'room1');
    rm.unsubscribe(a, 'room1');

    expect(rm.publish('room1', { event: 'e', data: null })).toBe(0);
    expect(rm.roomSize('room1')).toBe(0);
  });

  it('empty rooms are garbage-collected across many subscribe/unsubscribe cycles', () => {
    const rm = new RoomManager();
    for (let i = 0; i < 1000; i++) {
      const sub = makeSub();
      const room = `room-${i}`;
      rm.subscribe(sub, room);
      rm.unsubscribe(sub, room);
      expect(rm.roomSize(room)).toBe(0);
    }
  });
});
