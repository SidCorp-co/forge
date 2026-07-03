import { describe, expect, it } from 'vitest';
import {
  RocketChatDdpClient,
  type RocketChatIncomingMessage,
  type WsLike,
  ddpUrl,
  parseStreamMessage,
} from './ddp-client.js';

describe('ddpUrl', () => {
  it('derives the wss /websocket endpoint', () => {
    expect(ddpUrl('https://chat.sidcorp.co/')).toBe('wss://chat.sidcorp.co/websocket');
    expect(ddpUrl('http://localhost:3000')).toBe('ws://localhost:3000/websocket');
  });
});

describe('parseStreamMessage', () => {
  it('maps a normal message', () => {
    const m = parseStreamMessage({
      _id: 'm1',
      rid: 'r1',
      msg: 'hello',
      u: { _id: 'u1', username: 'alice' },
      ts: '2026-07-03T00:00:00.000Z',
    });
    expect(m).toEqual({
      id: 'm1',
      rid: 'r1',
      text: 'hello',
      userId: 'u1',
      username: 'alice',
      ts: '2026-07-03T00:00:00.000Z',
      isSystem: false,
      isEdited: false,
    });
  });

  it('flags system + edited messages and rejects malformed', () => {
    expect(parseStreamMessage({ _id: 'm', rid: 'r', t: 'au', u: { _id: 'u' } })?.isSystem).toBe(
      true,
    );
    expect(
      parseStreamMessage({ _id: 'm', rid: 'r', editedAt: { $date: 1 }, u: { _id: 'u' } })?.isEdited,
    ).toBe(true);
    expect(parseStreamMessage({ msg: 'x' })).toBeNull();
    expect(parseStreamMessage(null)).toBeNull();
  });
});

// A scriptable fake WebSocket to drive the DDP handshake deterministically.
class FakeWs implements WsLike {
  sent: string[] = [];
  private handlers: Record<string, (...a: unknown[]) => void> = {};
  on(ev: string, cb: (...a: unknown[]) => void) {
    this.handlers[ev] = cb;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.handlers.close?.();
  }
  emitOpen() {
    this.handlers.open?.();
  }
  emit(frame: object) {
    this.handlers.message?.(JSON.stringify(frame));
  }
  lastMethod() {
    return this.sent.map((s) => JSON.parse(s)).reverse();
  }
}

describe('RocketChatDdpClient handshake', () => {
  it('connect → login → subscribe → live, then routes changed messages', async () => {
    const received: RocketChatIncomingMessage[] = [];
    const fake = new FakeWs();
    const client = new RocketChatDdpClient({
      serverUrl: 'https://rc.test',
      authToken: 'tok',
      userId: 'bot',
      onMessage: (m) => received.push(m),
      wsFactory: () => fake,
    });

    const connected = client.connect();
    fake.emitOpen();
    // client sends connect handshake
    expect(JSON.parse(fake.sent[0] ?? '{}').msg).toBe('connect');
    fake.emit({ msg: 'connected', session: 's' });
    // client sends login (method) — grab its id
    const loginFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'login');
    expect(loginFrame.params[0]).toEqual({ resume: 'tok' });
    fake.emit({ msg: 'result', id: loginFrame.id });
    // client subscribes
    const subFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.msg === 'sub');
    expect(subFrame.name).toBe('stream-room-messages');
    expect(subFrame.params).toEqual(['__my_messages__', false]);
    fake.emit({ msg: 'ready', subs: [subFrame.id] });
    await connected;
    expect(client.getState()).toBe('live');

    // incoming room message routed to onMessage
    fake.emit({
      msg: 'changed',
      collection: 'stream-room-messages',
      fields: {
        eventName: '__my_messages__',
        args: [{ _id: 'm1', rid: 'r1', msg: 'hi', u: { _id: 'u2', username: 'bob' } }],
      },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('hi');

    // answers server ping with pong
    fake.emit({ msg: 'ping' });
    expect(fake.sent.map((s) => JSON.parse(s)).some((f) => f.msg === 'pong')).toBe(true);
  });
});
