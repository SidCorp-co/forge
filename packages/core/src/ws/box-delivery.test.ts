import { describe, expect, it } from 'vitest';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { boxIsListening, sendToBoxNow } from './box-delivery.js';

const socket = (readyState: number) => {
  const frames: string[] = [];
  return { readyState, send: (f: string) => frames.push(f), frames };
};

describe('the WebSocket door answers presence for a box', () => {
  it('reads no listener until a socket joins the box room, and none after it leaves', () => {
    const s = socket(1);
    expect(boxIsListening('d-presence')).toBe(false);
    roomManager.subscribe(s as never, deviceRoom('d-presence'));
    expect(boxIsListening('d-presence')).toBe(true);
    roomManager.removeAll(s as never);
    expect(boxIsListening('d-presence')).toBe(false);
  });

  it('hands a frame to the open sockets now and counts them', () => {
    const open = socket(1);
    const closing = socket(2);
    roomManager.subscribe(open as never, deviceRoom('d-send'));
    roomManager.subscribe(closing as never, deviceRoom('d-send'));
    expect(sendToBoxNow('d-send', { event: 'agent:send', data: {} })).toBe(1);
    expect(open.frames).toHaveLength(1);
    expect(closing.frames).toHaveLength(0);
    roomManager.removeAll(open as never);
    roomManager.removeAll(closing as never);
  });

  it('keeps no frame it handed a box for a socket that subscribes later', () => {
    const early = socket(1);
    roomManager.subscribe(early as never, deviceRoom('d-nokeep'));
    expect(sendToBoxNow('d-nokeep', { event: 'agent:send', data: { turnToken: 'x' } })).toBe(1);
    const late = socket(1);
    expect(roomManager.replay(late as never, deviceRoom('d-nokeep'), 60_000).frames).toBe(0);
    expect(late.frames).toHaveLength(0);
    roomManager.removeAll(early as never);
  });
});
