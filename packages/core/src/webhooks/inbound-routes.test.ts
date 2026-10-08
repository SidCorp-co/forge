/**
 * ISS-1252 — what Sentry holds when an inbound webhook adapter throws.
 *
 * The route is driven end to end through the real error handler and the real Sentry client, whose
 * ingest is a loopback server that keeps every envelope it is sent. The adapter, the registry, the
 * binding store and the database are stand-ins: the subject is the hand-off from the adapter catch
 * to the event, and what the caller is told.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => fakeLogger,
};
vi.mock('../logger.js', () => ({ logger: fakeLogger, getLogger: () => fakeLogger }));

const SLUG = 'forge-dev';
const BINDING_ID = '5f1c2d9e-0b1a-4c55-9a77-3a4b9c0d1e22';
const SECRET = 'whsec-inbound-routes-test';
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGlj$c2VudHJ5LWhhc2g';
const EMAIL = 'dup@example.test';

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ id: 'project-1', secret: null }] }) }),
    }),
  },
}));

const handleInbound = vi.fn();
vi.mock('../integrations/registry.js', () => ({
  getAdapter: () => ({ handleInbound }),
  listIntegrations: () => [
    {
      provider: 'github',
      capabilities: {
        canReceiveWebhook: true,
        webhookHeader: 'x-github-event',
        webhookSignatureHeader: 'x-hub-signature-256',
      },
    },
  ],
}));
vi.mock('../integrations/store.js', () => ({
  listActiveBindingsForProjectProvider: async () => [
    { binding: { id: BINDING_ID, integrationSecret: SECRET, role: 'source', stages: [] } },
  ],
  buildContextFromBinding: () => ({}),
}));
vi.mock('../integrations/inbound-door.js', () => ({
  recordTurnedAwayInboundCall: vi.fn(async () => undefined),
}));

const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

import type { RequestIdVars } from '../middleware/request-id.js';

const { signHmacSha256 } = await import('./hmac.js');
const { webhookInboundRoutes } = await import('./inbound-routes.js');

let ingest: Server;
const envelopes: string[] = [];

beforeAll(async () => {
  ingest = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      envelopes.push(
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(body).toString() : body.toString(),
      );
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const { port } = ingest.address() as AddressInfo;
  vi.stubEnv('SENTRY_DSN', `http://public@127.0.0.1:${port}/1`);
  const { initSentry } = await import('../observability/sentry.js');
  expect(initSentry()).toBe(true);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => ingest.close(() => resolve()));
});

beforeEach(() => {
  envelopes.length = 0;
  handleInbound.mockReset();
});

interface SentEvent {
  exception?: { values?: { type?: string; value?: string }[] };
  tags?: Record<string, string>;
}

/** Every error event the ingest was sent, read back out of the envelopes. */
function sentEvents(): SentEvent[] {
  return envelopes
    .flatMap((envelope) => envelope.split('\n'))
    .flatMap((line) => {
      try {
        const item = JSON.parse(line) as SentEvent;
        return item.exception ? [item] : [];
      } catch {
        return [];
      }
    });
}

/** The exception values of one event, the thrown one last, as the client orders them. */
const valuesOf = (event: SentEvent) => event.exception?.values ?? [];

async function deliver(): Promise<Response> {
  const { Sentry } = await import('../observability/sentry.js');
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/', webhookInboundRoutes);
  app.onError(errorHandler);
  const body = JSON.stringify({ zen: 'keep it logically awesome' });
  const res = await app.request(`/in/${SLUG}`, {
    method: 'POST',
    headers: {
      'x-github-event': 'ping',
      'x-hub-signature-256': signHmacSha256(SECRET, body),
      'content-type': 'application/json',
    },
    body,
  });
  expect(await Sentry.flush(5000)).toBe(true);
  return res;
}

class RateLimitedError extends Error {
  override name = 'RateLimitedError';
}
class StageMissingError extends Error {
  override name = 'StageMissingError';
}

describe('an inbound webhook whose adapter throws', () => {
  it("sends Sentry the adapter's own error, tagged with the provider, slug and binding", async () => {
    handleInbound.mockRejectedValue(new RateLimitedError('github secondary rate limit hit'));
    const res = await deliver();
    expect(res.status).toBe(500);

    const events = sentEvents();
    expect(events).toHaveLength(1);
    const [event] = events as [SentEvent];
    const thrown = valuesOf(event).at(-1);
    expect(thrown).toMatchObject({
      type: 'RateLimitedError',
      value: 'github secondary rate limit hit',
    });
    expect(valuesOf(event).map((v) => v.value)).not.toContain('handler failed');
    expect(event.tags).toMatchObject({
      'webhook.provider': 'github',
      'webhook.slug': SLUG,
      'webhook.binding_id': BINDING_ID,
      'error.code': 'HANDLER_FAILED',
      'http.method': 'POST',
      'http.path': `/in/${SLUG}`,
    });
    expect(event.tags?.['request.id']).toBeTruthy();
  });

  it('sends two differently named failures as two different events', async () => {
    handleInbound.mockRejectedValueOnce(new RateLimitedError('slow down'));
    await deliver();
    handleInbound.mockRejectedValueOnce(new StageMissingError('no stage named review'));
    await deliver();

    const thrown = sentEvents().map((e) => valuesOf(e).at(-1));
    expect(thrown).toHaveLength(2);
    expect(thrown[0]).toMatchObject({ type: 'RateLimitedError', value: 'slow down' });
    expect(thrown[1]).toMatchObject({ type: 'StageMissingError', value: 'no stage named review' });
  });

  it('still answers HANDLER_FAILED, with none of the adapter in the body', async () => {
    handleInbound.mockRejectedValue(new RateLimitedError('github secondary rate limit hit'));
    const res = await deliver();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ code: 'HANDLER_FAILED', message: 'handler failed' });
    expect(text).not.toContain('RateLimited');
    expect(text).not.toContain(BINDING_ID);
  });

  it("sends a failed query's statement and none of its bound params", async () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "u"'), {
      code: '23505',
      severity: 'ERROR',
    });
    const failed = new DrizzleQueryError(
      'insert into "users" values ($1, $2)',
      [EMAIL, HASH],
      driver,
    );
    handleInbound.mockRejectedValue(new Error('could not record delivery', { cause: failed }));
    await deliver();

    const [event] = sentEvents() as [SentEvent];
    const values = valuesOf(event).map((v) => v.value);
    expect(values).toContain('could not record delivery');
    expect(values.some((v) => v?.startsWith('Failed query: insert into "users"'))).toBe(true);
    const sent = envelopes.join('\n');
    expect(sent).not.toContain(HASH);
    expect(sent).not.toContain(EMAIL);
  });

  it('sends a thrown value that is not an Error as an Error saying so, with the same tags', async () => {
    handleInbound.mockRejectedValue('a bare string');
    const res = await deliver();
    expect(res.status).toBe(500);

    const [event] = sentEvents() as [SentEvent];
    expect(valuesOf(event).at(-1)?.value).toMatch(/not an Error/);
    expect(event.tags).toMatchObject({ 'webhook.provider': 'github', 'webhook.slug': SLUG });
  });
});

describe('an inbound webhook whose adapter refuses the signature', () => {
  it('answers 401 INVALID_SIGNATURE and sends nothing to Sentry', async () => {
    handleInbound.mockRejectedValue(new Error('bad signature'));
    const res = await deliver();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(sentEvents()).toHaveLength(0);
  });
});
