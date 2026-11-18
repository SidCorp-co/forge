// A browser box's view against a stand-in for agent-browser 0.43's stream: its messages are built
// with sorted keys (`type` last), it sends a joining client its newest frame at once, and a daemon
// that restarts comes back on a new port (ISS-1315).

import { connect } from 'node:net';
import { Duplex } from 'node:stream';
import type { BoxViewFault } from '@forge/contracts/box-wire';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { FRAME_RELAY, type OpenView, relayFrames, viewerFrameOf } from './frame-relay.js';

const ID = '0b8e7a52-3c4d-4e6f-8a1b-2c3d4e5f6a7b';

/** What serde_json writes for a `json!` object without `preserve_order`: keys sorted. */
const sorted = (o: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
const frameMsg = (seq: number, data: string) =>
  sorted({ type: 'frame', seq, data, metadata: { deviceWidth: 1280, deviceHeight: 720 } });

interface FakeStream {
  port: number;
  urls: string[];
  /** Publish a changed frame to every client. */
  publish(seq: number, data: string): void;
  close(): Promise<void>;
}

const servers: FakeStream[] = [];

/** agent-browser's stream: status and tabs on connect, then its newest frame, if it has one. */
async function fakeStream(seed: string | null): Promise<FakeStream> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const urls: string[] = [];
  let newest = seed === null ? null : frameMsg(1, seed);
  wss.on('connection', (ws, req) => {
    urls.push(req.url ?? '');
    ws.send(sorted({ type: 'status', connected: true, screencasting: true, viewportWidth: 1280 }));
    ws.send(sorted({ type: 'tabs', tabs: [{ url: 'https://example.com' }], timestamp: 1 }));
    if (newest) ws.send(newest);
  });
  const s: FakeStream = {
    port: (wss.address() as { port: number }).port,
    urls,
    publish: (seq, data) => {
      newest = frameMsg(seq, data);
      for (const c of wss.clients) c.send(newest);
    },
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
  };
  servers.push(s);
  return s;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

interface Seen {
  frames: Array<{ type: string; seq: number | null; data: string }>;
  failed: { code: BoxViewFault; why: string } | null;
  close: () => void;
}

function watch(first: Duplex, reopen: OpenView, fps: number, limits = FRAME_RELAY): Seen {
  const closers: Array<() => void> = [];
  const seen: Seen = {
    frames: [],
    failed: null,
    close: () => {
      for (const c of closers) c();
    },
  };
  relayFrames(
    ID,
    {
      frame: (t) => seen.frames.push(JSON.parse(t)),
      fail: (code, why) => {
        seen.failed = { code, why };
      },
      onClose: (fn) => closers.push(fn),
    },
    first,
    reopen,
    fps,
    limits,
  );
  return seen;
}

const to = (port: number) => connect(port, '127.0.0.1');
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
};

/** A tunnel stream the device reset, as core's tunnel ends one (`previews/tunnel.ts:streamEnded`). */
function refusedStream(): Duplex {
  const d = new Duplex({
    read() {},
    write(_c, _e, cb) {
      cb();
    },
  });
  setImmediate(() =>
    d.destroy(new Error('preview tunnel stream CONNECT_REFUSED', { cause: 'CONNECT_REFUSED' })),
  );
  return d;
}

const fast = { ...FRAME_RELAY, reopenDelayMs: 20, firstFrameMs: 1_500 };

describe("a browser box's view carries agent-browser's frames", () => {
  it('reads a frame whose keys are sorted, and nothing else agent-browser sends', () => {
    expect(JSON.parse(viewerFrameOf(frameMsg(7, 'AAAA')) as string)).toEqual({
      type: 'frame',
      seq: 7,
      data: 'AAAA',
    });
    expect(viewerFrameOf(sorted({ type: 'status', connected: true }))).toBeNull();
    expect(viewerFrameOf(sorted({ type: 'frame', seq: 2, data: '' }))).toBeNull();
    expect(viewerFrameOf('not json')).toBeNull();
  });

  it('gives a viewer joining a static page its picture within 2 s', async () => {
    const page = await fakeStream('c3RhdGljIHBhZ2U=');
    const seen = watch(to(page.port), async () => ({ ok: true, stream: to(page.port) }), 10);
    expect(await until(() => seen.frames.length > 0, 2_000)).toBe(true);
    expect(seen.frames[0]).toEqual({ type: 'frame', seq: 1, data: 'c3RhdGljIHBhZ2U=' });
    expect(page.urls[0]).toBe('/?maxFps=10');
    seen.close();
  });

  it('sends each changed frame at the viewer’s rate, the newest last', async () => {
    const page = await fakeStream('Zmlyc3Q=');
    const seen = watch(to(page.port), async () => ({ ok: true, stream: to(page.port) }), 5);
    expect(await until(() => seen.frames.length === 1, 2_000)).toBe(true);
    for (let i = 2; i <= 20; i++) page.publish(i, `ZnJhbWU${i}`);
    await new Promise((r) => setTimeout(r, 700));
    // at 5 a second, 700 ms after the first frame allows four more at most
    expect(seen.frames.length).toBeGreaterThanOrEqual(2);
    expect(seen.frames.length).toBeLessThanOrEqual(5);
    expect(seen.frames.at(-1)?.seq).toBe(20);
    seen.close();
  });
});

describe('a stream the view cannot read is said by name, or found again', () => {
  it('finds a daemon that restarted onto a new port', async () => {
    const old = await fakeStream('b2xk');
    const seen = watch(to(old.port), async () => ({ ok: true, stream: to(moved.port) }), 10, fast);
    expect(await until(() => seen.frames.length === 1, 2_000)).toBe(true);
    const moved = await fakeStream('bW92ZWQ=');
    await old.close();
    expect(await until(() => seen.frames.length === 2, 2_000)).toBe(true);
    expect(seen.frames[1]?.data).toBe('bW92ZWQ=');
    expect(seen.failed).toBeNull();
    seen.close();
  });

  it('closes the view STREAM_UNREADABLE, naming the refusal, when the port stays dead', async () => {
    const seen = watch(
      refusedStream(),
      async () => ({ ok: true, stream: refusedStream() }),
      10,
      fast,
    );
    expect(await until(() => seen.failed !== null, 2_000)).toBe(true);
    expect(seen.failed?.code).toBe('STREAM_UNREADABLE');
    expect(seen.failed?.why).toContain('CONNECT_REFUSED');
    expect(seen.failed?.why).toContain(`${fast.reopenTries + 1} times in a row`);
  });

  it('closes the view STREAM_SILENT when the stream answers but sends no frame', async () => {
    const page = await fakeStream(null);
    const seen = watch(to(page.port), async () => ({ ok: true, stream: to(page.port) }), 10, {
      ...fast,
      firstFrameMs: 200,
    });
    expect(await until(() => seen.failed !== null, 2_000)).toBe(true);
    expect(seen.failed?.code).toBe('STREAM_SILENT');
    expect(seen.frames).toEqual([]);
  });
});
