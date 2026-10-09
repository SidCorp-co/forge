import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { TUNNEL_LIMITS } from '@forge/contracts/preview-tunnel';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.hoisted(() => {
  process.env.PREVIEW_DOMAIN = 'preview.localhost:7311';
});

import { api } from '../helpers/api.js';
import { atPreview, cookieOf, PreviewWorld } from '../helpers/preview-world.js';

// REQ-39 BC-1..3: a browser that opens many connections to a preview at once is served, not
// refused; every connection is given back however it ends; and what the relay refuses it refuses
// by name. Real sockets: core, a dev server, and a box speaking the runner's frames.

const world = new PreviewWorld();
let preview: { id: string; url: string };
let cookie = '';

const limits = TUNNEL_LIMITS as { -readonly [K in keyof typeof TUNNEL_LIMITS]: number };
const saved = { ...TUNNEL_LIMITS };

beforeAll(() => world.start(), 120_000);

/** The live preview and a member's cookie on it, made once by the first test that needs them. */
async function ready() {
  if (cookie === '') {
    preview = await world.livePreview(world.issueId);
    cookie = cookieOf((await world.enter(preview)).entered.headers['set-cookie']);
  }
}

afterAll(async () => {
  Object.assign(limits, saved);
  world.dev.release();
  await world.stop();
});

const record = async () =>
  (await api(world.owner, 'GET', `/api/previews/${preview.id}`)).body.preview as {
    streams: number;
    streamsWaiting: number;
  };
const streams = async () => (await record()).streams;

/** A request kept open, with the way to abort it. */
function hold(path: string, headers: Record<string, string> = {}) {
  const req = httpRequest({
    host: '127.0.0.1',
    port: world.core.port,
    path,
    headers: { host: new URL(preview.url).host, cookie, ...headers },
  });
  const done = new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
    (resolve) => {
      req.on('response', (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on('error', () => resolve({ status: 0, headers: {}, text: '' }));
    },
  );
  req.end();
  return { req, done };
}

it('serves 200 parallel requests to one preview, none refused, never more than the limit open (BC-1)', async () => {
  await ready();
  const answers = await Promise.all(
    Array.from({ length: 200 }, () =>
      atPreview(world.core, preview.url, '/slow', { cookie, 'sec-fetch-dest': 'script' }),
    ),
  );
  expect(answers.filter((a) => a.status !== 200).map((a) => a.status)).toEqual([]);
  expect(world.dev.peak()).toBeLessThanOrEqual(TUNNEL_LIMITS.maxStreamsPerPreview);
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);
}, 60_000);

it('gives a stream back when the browser aborts, and says how many a preview holds (BC-1)', async () => {
  await ready();
  const held = Array.from({ length: 10 }, () => hold('/hold'));
  await expect.poll(streams, { timeout: 10_000 }).toBe(10);
  for (const h of held) h.req.destroy();
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);
  await expect.poll(() => world.dev.sockets(), { timeout: 10_000 }).toBe(0);
});

it('gives a stream back when a hot-reload socket closes, however it closes (BC-2)', async () => {
  await ready();
  const ws = new WebSocket(`ws://127.0.0.1:${world.core.port}/hmr`, {
    headers: { host: new URL(preview.url).host, cookie },
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  await expect.poll(streams, { timeout: 10_000 }).toBe(1);
  ws.close();
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);

  // the browser goes before the upgrade is answered: an upgrade the dev server takes and never
  // answers, then the browser's socket dies
  const raw = connect(world.core.port, '127.0.0.1');
  raw.write(
    `GET /silent HTTP/1.1\r\nHost: ${new URL(preview.url).host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
  );
  await expect.poll(streams, { timeout: 10_000 }).toBe(1);
  raw.destroy();
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);
  await expect.poll(() => world.dev.sockets(), { timeout: 10_000 }).toBe(0);
});

it('queues a request past the limit and serves it when a stream is released (BC-1)', async () => {
  await ready();
  const held = Array.from({ length: TUNNEL_LIMITS.maxStreamsPerPreview }, () => hold('/hold'));
  await expect.poll(streams, { timeout: 10_000 }).toBe(TUNNEL_LIMITS.maxStreamsPerPreview);
  const waiting = hold('/hold', { 'sec-fetch-dest': 'script' });
  await expect.poll(async () => (await record()).streamsWaiting, { timeout: 10_000 }).toBe(1);
  held[0]?.req.destroy();
  await expect.poll(async () => (await record()).streamsWaiting, { timeout: 10_000 }).toBe(0);
  expect(await streams()).toBe(TUNNEL_LIMITS.maxStreamsPerPreview);
  world.dev.release();
  const answer = await waiting.done;
  expect(answer.status).toBe(200);
  for (const h of held) h.req.destroy();
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);
});

it('takes a request out of the queue when its browser leaves, and opens no stream for it (BC-1)', async () => {
  await ready();
  const held = Array.from({ length: TUNNEL_LIMITS.maxStreamsPerPreview }, () => hold('/hold'));
  await expect.poll(streams, { timeout: 10_000 }).toBe(TUNNEL_LIMITS.maxStreamsPerPreview);
  const gone = hold('/hold');
  await expect.poll(async () => (await record()).streamsWaiting, { timeout: 10_000 }).toBe(1);
  gone.req.destroy();
  await expect.poll(async () => (await record()).streamsWaiting, { timeout: 10_000 }).toBe(0);
  held[0]?.req.destroy();
  await expect.poll(streams, { timeout: 10_000 }).toBe(TUNNEL_LIMITS.maxStreamsPerPreview - 1);
  expect(world.dev.held()).toBe(TUNNEL_LIMITS.maxStreamsPerPreview - 1);
  for (const h of held) h.req.destroy();
  await expect.poll(streams, { timeout: 10_000 }).toBe(0);
});

it('refuses by name a request that waits too long, and one that finds the queue full (BC-1)', async () => {
  await ready();
  limits.streamWaitSeconds = 1;
  limits.maxQueuedPerPreview = 1;
  try {
    const held = Array.from({ length: TUNNEL_LIMITS.maxStreamsPerPreview }, () => hold('/hold'));
    await expect.poll(streams, { timeout: 10_000 }).toBe(TUNNEL_LIMITS.maxStreamsPerPreview);

    const queued = hold('/hold', { 'sec-fetch-dest': 'script' });
    await expect.poll(async () => (await record()).streamsWaiting, { timeout: 10_000 }).toBe(1);
    // the queue holds one: the next is refused at once, as a document with the busy page
    const full = await hold('/hold', { 'sec-fetch-dest': 'document', accept: 'text/html' }).done;
    expect(full.status).toBe(503);
    expect(full.headers['x-forge-preview-refusal']).toBe('STREAM_QUEUE_FULL');
    expect(full.headers['retry-after']).toBe('2');
    expect(full.text).toContain('This preview is busy');

    // the one waiting is refused when its wait ends: plain text and Retry-After for a script
    const late = await queued.done;
    expect(late.status).toBe(503);
    expect(late.headers['x-forge-preview-refusal']).toBe('STREAM_WAIT_TIMEOUT');
    expect(late.headers['retry-after']).toBe('2');
    expect(String(late.headers['content-type'])).toContain('text/plain');
    expect(late.text).toContain('busy');
    expect((await record()).streamsWaiting).toBe(0);

    for (const h of held) h.req.destroy();
    await expect.poll(streams, { timeout: 10_000 }).toBe(0);
  } finally {
    Object.assign(limits, saved);
    world.dev.release();
  }
}, 60_000);

it('says why on every refusal, an upgrade included (BC-1)', async () => {
  await ready();
  const missing = await atPreview(world.core, preview.url, '/slow');
  expect(missing.status).toBe(403);
  expect(missing.headers['x-forge-preview-refusal']).toBe('SIGN_IN_REQUIRED');

  const refused = new WebSocket(`ws://127.0.0.1:${world.core.port}/hmr`, {
    headers: { host: new URL(preview.url).host },
  });
  const answer = await new Promise<{ status: number; reason: unknown; body: string }>((resolve) => {
    refused.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        body += String(c);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          reason: res.headers['x-forge-preview-refusal'],
          body,
        }),
      );
    });
  });
  expect(answer).toMatchObject({ status: 403, reason: 'SIGN_IN_REQUIRED' });
  expect(answer.body).not.toBe('');
});
