import { afterEach, describe, expect, it, vi } from 'vitest';
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
      mentions: [],
    });
  });

  it('extracts @-mention user ids', () => {
    const m = parseStreamMessage({
      _id: 'm2',
      rid: 'r1',
      msg: '@chuong_bot hi',
      u: { _id: 'u1' },
      mentions: [{ _id: 'botid', username: 'chuong_bot' }],
    });
    expect(m?.mentions).toEqual(['botid']);
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

    client.close();
  });
});

describe('RocketChatDdpClient subscription loss', () => {
  it('post-ready nosub closes the socket so the manager redials (silent-deaf fix)', async () => {
    const closes: unknown[] = [];
    const errors: Error[] = [];
    const fake = new FakeWs();
    const client = new RocketChatDdpClient({
      serverUrl: 'https://rc.test',
      authToken: 'tok',
      userId: 'bot',
      onMessage: () => {},
      onClose: (i) => closes.push(i),
      onError: (e) => errors.push(e),
      wsFactory: () => fake,
    });
    const connected = client.connect();
    fake.emitOpen();
    fake.emit({ msg: 'connected', session: 's' });
    const loginFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'login');
    fake.emit({ msg: 'result', id: loginFrame.id });
    const subFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.msg === 'sub');
    fake.emit({ msg: 'ready', subs: [subFrame.id] });
    await connected;
    expect(client.getState()).toBe('live');

    // Server TERMINATES the subscription after it went live — previously a
    // silent no-op that left the bot deaf; now it must close → redial.
    fake.emit({ msg: 'nosub', id: subFrame.id, error: { error: 'stream-not-allowed' } });
    expect(errors.some((e) => /subscription lost/i.test(e.message))).toBe(true);
    expect(client.getState()).toBe('closed');
    expect(closes).toHaveLength(1);
  });

  it('pre-ready nosub rejects connect', async () => {
    const fake = new FakeWs();
    const client = new RocketChatDdpClient({
      serverUrl: 'https://rc.test',
      authToken: 'tok',
      userId: 'bot',
      onMessage: () => {},
      wsFactory: () => fake,
    });
    const connected = client.connect();
    fake.emitOpen();
    fake.emit({ msg: 'connected', session: 's' });
    const loginFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'login');
    fake.emit({ msg: 'result', id: loginFrame.id });
    const subFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.msg === 'sub');
    fake.emit({ msg: 'nosub', id: subFrame.id, error: { error: 'denied' } });
    await expect(connected).rejects.toThrow(/subscription rejected/i);
  });
});

describe('RocketChatDdpClient watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings a quiet link, then closes a dead one so the manager redials', async () => {
    vi.useFakeTimers();
    const fake = new FakeWs();
    const client = new RocketChatDdpClient({
      serverUrl: 'https://rc.test',
      authToken: 'tok',
      userId: 'bot',
      onMessage: () => {},
      wsFactory: () => fake,
    });
    const connected = client.connect();
    fake.emitOpen();
    fake.emit({ msg: 'connected', session: 's' });
    const loginFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'login');
    fake.emit({ msg: 'result', id: loginFrame.id });
    const subFrame = fake.sent.map((s) => JSON.parse(s)).find((f) => f.msg === 'sub');
    fake.emit({ msg: 'ready', subs: [subFrame.id] });
    await connected;
    expect(client.getState()).toBe('live');

    // Quiet for 60s → client nudges with its own ping.
    vi.advanceTimersByTime(60_000);
    expect(fake.sent.map((s) => JSON.parse(s)).filter((f) => f.msg === 'ping')).toHaveLength(1);
    // Traffic resets the clock — no premature close.
    fake.emit({ msg: 'pong' });
    vi.advanceTimersByTime(60_000);
    expect(client.getState()).toBe('live');
    // Total silence past the dead threshold → the client closes itself.
    vi.advanceTimersByTime(150_000);
    expect(client.getState()).toBe('closed');
  });
});
