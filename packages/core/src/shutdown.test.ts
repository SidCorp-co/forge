// ISS-930: core's shutdown, run against a real HTTP server with a write held open across it. A
// write in flight finishes before anything it uses is torn down, a request that arrives while core
// drains is answered 503 with Retry-After rather than refused at the socket (which a proxy answers
// as 502), /health says it is draining, and the database closes last.
import { once } from 'node:events';
import { Agent, createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./health/service.js', () => ({
  readLiveness: async () => ({ ok: true, dbOk: true, queueOk: true, wsOk: true }),
}));
vi.mock('./lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

type Harness = {
  base: string;
  server: Server;
  order: string[];
  /** Resolves when the held write has committed and is waiting to answer. */
  committed: Promise<void>;
  /** Lets the held write answer. */
  release: () => void;
  steps: import('./shutdown.js').ShutdownSteps;
};

let harness: Harness;

async function start(): Promise<Harness> {
  vi.resetModules();
  const { coreDrain } = await import('./lib/drain.js');
  const { publicHealthRoutes } = await import('./health/routes.js');
  const order: string[] = [];
  let queueRunning = true;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed!: () => void;
  const committedP = new Promise<void>((resolve) => {
    committed = resolve;
  });

  const app = new Hono();
  app.route('/', publicHealthRoutes);
  app.post('/write', async (c) => {
    order.push('write committed');
    committed();
    await released;
    // a write enqueues its follow-up job after it commits, as an outbox event or a pg-boss send does
    if (!queueRunning) throw new Error('queue stopped under an in-flight write');
    order.push('write answered');
    return c.json({ ok: true });
  });
  app.post('/other', (c) => c.json({ ok: true }));

  const step = (name: string, after?: () => void) => ({
    name,
    run: async () => {
      after?.();
      order.push(`${name} stopped`);
    },
  });
  const steps = {
    services: [
      step('ws'),
      step('timers'),
      step('queue', () => {
        queueRunning = false;
      }),
    ],
    database: step('db'),
  };

  const server = createServer(coreDrain.gate(getRequestListener(app.fetch)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    order,
    committed: committedP,
    release,
    steps,
  };
}

type Limits = { deregisterMs: number; httpDrainMs: number; timeoutMs: number };
// the proxy's deregistration wait cut to a test's scale; the real one is in shutdown-grace.test.ts
const TEST_LIMITS: Limits = { deregisterMs: 400, httpDrainMs: 15_000, timeoutMs: 25_000 };

const shutdown = async (h: Harness, limits: Partial<Limits> = {}, signal = 'SIGTERM') => {
  const { runShutdown } = await import('./shutdown.js');
  return runShutdown(signal, h.server, h.steps, { ...TEST_LIMITS, ...limits });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request on `agent`, answered as status, headers and body, or why it got no answer. */
const viaAgent = (url: string, method: string, agent: Agent) =>
  new Promise<{
    status: number | string;
    connection?: string | undefined;
    retryAfter?: string | undefined;
    body?: unknown;
  }>((resolve) => {
    const req = request(url, { method, agent }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({
          status: res.statusCode ?? 0,
          connection: res.headers.connection,
          retryAfter: res.headers['retry-after'],
          body,
        });
      });
    });
    req.on('error', (err) =>
      resolve({
        status: `no answer: the socket was refused or closed (${(err as { code?: string }).code ?? String(err)})`,
      }),
    );
    req.end();
  });

// a socket refused or closed under the request throws instead of answering; name it so the diff reads it
const statusOf = async (url: string, init?: RequestInit) => {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return {
      status: `no answer: the socket was refused or closed (${cause?.code ?? String(err)})`,
    };
  }
};

beforeEach(async () => {
  harness = await start();
});
afterEach(() => {
  harness.release();
  harness.server.closeAllConnections();
  harness.server.close();
});

describe('core drains HTTP before it tears anything down (ISS-930)', () => {
  it('answers a write in flight at SIGTERM with 200, before the services it uses stop', async () => {
    const write = fetch(`${harness.base}/write`, { method: 'POST' });
    await harness.committed;
    const done = shutdown(harness);
    await new Promise((resolve) => setTimeout(resolve, 50));
    harness.release();
    expect((await write).status).toBe(200);
    expect(await done).toBe(0);
    expect(harness.order).toEqual([
      'write committed',
      'write answered',
      'ws stopped',
      'timers stopped',
      'queue stopped',
      'db stopped',
    ]);
  });

  it('answers a request that arrives while draining 503 with Retry-After, never at the socket', async () => {
    const write = fetch(`${harness.base}/write`, { method: 'POST' });
    await harness.committed;
    const done = shutdown(harness);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const late = await statusOf(`${harness.base}/other`, { method: 'POST' });
    expect(late).toMatchObject({ status: 503, retryAfter: '20', body: { code: 'CORE_DRAINING' } });
    harness.release();
    expect((await write).status).toBe(200);
    expect(await done).toBe(0);
  });

  it('answers /health 503 draining once shutdown starts', async () => {
    expect((await statusOf(`${harness.base}/health`)).status).toBe(200);
    const write = fetch(`${harness.base}/write`, { method: 'POST' });
    await harness.committed;
    const done = shutdown(harness);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const health = await statusOf(`${harness.base}/health`);
    expect(health).toMatchObject({
      status: 503,
      retryAfter: '20',
      body: { ok: false, draining: true },
    });
    harness.release();
    await write;
    expect(await done).toBe(0);
  });

  it('stops waiting on a request that outlives the drain bound, and still closes the database', async () => {
    const write = fetch(`${harness.base}/write`, { method: 'POST' }).catch(() => null);
    await harness.committed;
    const started = Date.now();
    expect(await shutdown(harness, { httpDrainMs: 200, timeoutMs: 2_000 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(harness.order.at(-1)).toBe('db stopped');
    harness.release();
    await write;
  });
});

// ISS-930 round 2. The proxy (Traefik, through Docker's events) keeps routing to the old core until
// it reads it unhealthy or gone, which is seconds after SIGTERM, not at it. With nothing in flight
// the drain settled at once and the listener closed under the proxy's next request, which it
// answered 502 (forge-dev's rollovers on 2026-11-16). Core keeps answering 503 until the proxy can
// have stopped routing to it, and only then closes the listener and cuts its kept-alive sockets.
describe('core answers until the proxy has stopped routing to it (ISS-930)', () => {
  it('answers a request that arrives just after SIGTERM 503, with nothing in flight, never at the socket', async () => {
    const done = shutdown(harness);
    await sleep(150);
    const late = await statusOf(`${harness.base}/other`, { method: 'POST' });
    expect(late).toMatchObject({ status: 503, retryAfter: '20', body: { code: 'CORE_DRAINING' } });
    expect(await done).toBe(0);
  });

  it('answers a kept-alive connection the proxy reuses after SIGTERM 503 and closes it, rather than cutting it', async () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    let connections = 0;
    harness.server.on('connection', () => {
      connections += 1;
    });
    try {
      expect((await viaAgent(`${harness.base}/health`, 'GET', agent)).status).toBe(200);
      const done = shutdown(harness);
      await sleep(150);
      const reused = await viaAgent(`${harness.base}/other`, 'POST', agent);
      expect(reused).toMatchObject({
        status: 503,
        connection: 'close',
        retryAfter: '20',
        body: { code: 'CORE_DRAINING' },
      });
      expect(connections).toBe(1);
      expect(await done).toBe(0);
    } finally {
      agent.destroy();
    }
  });

  it('closes the listener once the proxy can have stopped routing, then tears the rest down', async () => {
    const started = Date.now();
    expect(await shutdown(harness, { deregisterMs: 300 })).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(harness.order).toEqual(['ws stopped', 'timers stopped', 'queue stopped', 'db stopped']);
    expect((await statusOf(`${harness.base}/health`)).status).toMatch(/^no answer/);
  });

  it("does not wait for a proxy on SIGINT, a terminal's stop with none in front", async () => {
    const started = Date.now();
    expect(await shutdown(harness, { deregisterMs: 5_000 }, 'SIGINT')).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// The kill itself. A SIGKILL at the end of the stop grace takes the process with every socket it
// holds, so a write that committed and is still answering reaches its caller as a closed socket,
// which a proxy answers as 502. Destroying every socket at the grace is that kill as the caller
// sees it. Core's budget sits under the grace, so core exits by itself before it lands.
describe('the stop grace against core budget (ISS-930)', () => {
  const sockets = new Set<import('node:net').Socket>();

  const run = async (graceMs: number) => {
    harness.server.on('connection', (s) => sockets.add(s));
    const answer = statusOf(`${harness.base}/write`, { method: 'POST' });
    await harness.committed;
    // the write takes 800 ms to answer after it commits
    setTimeout(harness.release, 800);
    const done = shutdown(harness, { httpDrainMs: 1_500, timeoutMs: 2_000 }).then(() => 'exited');
    const killed = new Promise<'killed'>((resolve) =>
      setTimeout(() => {
        for (const s of sockets) s.destroy();
        resolve('killed');
      }, graceMs),
    );
    const ended = await Promise.race([done, killed]);
    return { ended, answer: await answer, order: harness.order };
  };

  it('a grace shorter than the write kills it after it committed: the caller reads no answer', async () => {
    const r = await run(300);
    expect(r.ended).toBe('killed');
    expect(r.order).toContain('write committed');
    expect(r.answer.status).toMatch(/^no answer/);
  });

  it('a grace over the budget lets the write answer 200 and core exit by itself', async () => {
    const r = await run(4_000);
    expect(r.ended).toBe('exited');
    expect(r.answer.status).toBe(200);
  });
});
