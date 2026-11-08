// @direct-test-of packages/core/src/db/query-timing.ts
// @direct-test-of packages/core/src/middleware/server-timing.ts
// @direct-test-of packages/core/src/db/statement-shapes.ts
// @direct-test-of packages/core/src/lib/outbound-timing.ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@server-timing.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@server-timing.test';
});

import { db } from '../../src/db/client.js';
import { withQueryLeg } from '../../src/db/query-timing.js';
import { fingerprintOf, shapeTextOf } from '../../src/db/statement-shapes.js';
import { CoolifyClient } from '../../src/integrations/deploy/coolify/client.js';
import { readRuntimeProbe } from '../../src/integrations/deploy/runtime-probe.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../src/middleware/auth.js';
import { STATEMENT_SHAPES_HEADER, serverTiming } from '../../src/middleware/server-timing.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

// Every response says what the origin spent on it and how much of that was the database, so a
// person's wait splits into the network's share and the server's without a log to read.

interface Timing {
  db: number;
  queries: number;
  app: number;
  total: number;
}

function timingOf(headers: Headers): Timing {
  const raw = headers.get('server-timing');
  if (!raw) throw new Error('the response carries no Server-Timing header');
  const dur = (name: string) => {
    const m = new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(raw);
    if (!m?.[1]) throw new Error(`Server-Timing "${raw}" names no ${name} duration`);
    return Number(m[1]);
  };
  const queries = /db;dur=[0-9.]+;desc="(\d+) quer/.exec(raw)?.[1];
  if (queries === undefined) throw new Error(`Server-Timing "${raw}" names no query count`);
  return { db: dur('db'), queries: Number(queries), app: dur('app'), total: dur('total') };
}

describe('Server-Timing', () => {
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const owner = await createTestUser({ verified: true });
    const project = await createTestProject(owner.id);
    await addProjectMember(project.id, owner.id, 'owner');
    projectId = project.id;
    token = await userToken(owner.id);
  }, 120_000);

  it('reports a route that reads nothing as no queries and no database time', async () => {
    const res = await api(null, 'GET', '/api/version');
    expect(res.status).toBe(200);
    const t = timingOf(res.headers);
    expect(t).toMatchObject({ queries: 0, db: 0 });
    expect(t.total).toBeGreaterThanOrEqual(0);
  });

  it('counts the statements an authenticated read sends, inside its total', async () => {
    const res = await api(token, 'GET', `/api/projects/${projectId}/labels`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = timingOf(res.headers);
    expect(t.queries).toBeGreaterThan(0);
    expect(t.db).toBeGreaterThan(0);
    expect(t.db).toBeLessThanOrEqual(t.total);
    expect(t.app + t.db).toBeCloseTo(t.total, 0);
  });

  it('counts the statements of a refused request too', async () => {
    const res = await api(
      token,
      'GET',
      '/api/projects/00000000-0000-4000-8000-000000000000/labels',
    );
    expect(res.status).toBe(404);
    expect(timingOf(res.headers).queries).toBeGreaterThan(0);
  });

  it('names each Needs you area with its own statements, each counted to one area only', async () => {
    const res = await api(token, 'GET', `/api/projects/${projectId}/needs-you`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const raw = res.headers.get('server-timing') ?? '';
    const parts = new Map(
      [...raw.matchAll(/(?:^|, )([a-z-]+)(?:;dur=[0-9.]+)?;desc="(-?\d+) quer/g)].map((m) => [
        m[1] as string,
        Number(m[2]),
      ]),
    );
    const areas = ['ny-requirements', 'ny-feedback', 'ny-releases', 'ny-issues', 'ny-decisions'];
    for (const area of areas)
      expect(raw).toMatch(new RegExp(`${area};dur=[0-9.]+;desc="\\d+ quer`));
    // the areas share the request's count: never more than it, the rest sent outside every area
    const named = [...parts].filter(([n]) => n.startsWith('ny-')).reduce((n, [, q]) => n + q, 0);
    const outside = parts.get('unnamed');
    expect(outside, raw).toBeGreaterThanOrEqual(0);
    expect(named + (outside ?? 0), raw).toBe(parts.get('db'));
  });

  it('lets an allowed page read it cross-origin, and no other', async () => {
    const allowed = await api(null, 'GET', '/api/version', undefined, {
      origin: 'http://localhost:3000',
    });
    expect(allowed.headers.get('timing-allow-origin')).toBe('http://localhost:3000');
    expect(allowed.headers.get('access-control-expose-headers') ?? '').toMatch(/Server-Timing/i);
    const stranger = await api(null, 'GET', '/api/version', undefined, {
      origin: 'https://elsewhere.example',
    });
    expect(stranger.headers.get('timing-allow-origin')).toBeNull();
  });

  // ISS-1070 r11: live showed counts per area and never which statement repeats; an operator now
  // reads each area's most repeated shapes, fingerprinted, and nobody else reads any
  describe('the repeated statement shapes', () => {
    /** A read planted to send one statement once a row, beside one it sends once. */
    const ROWS = 7;
    const PER_ROW = 'SELECT $1::text AS planted_row_id';
    const planted = new Hono<{ Variables: AuthVars }>();
    planted.use(
      '*',
      serverTiming(() => false),
      requireAuth(),
      assertEmailVerified(),
    );
    planted.get('/planted', async (c) => {
      await withQueryLeg('planted-rows', async () => {
        await db.execute(sql`SELECT 1 AS once`);
        for (let n = 0; n < ROWS; n++)
          await db.execute(sql`SELECT ${`row-${n}`}::text AS planted_row_id`);
      });
      return c.json({ ok: true });
    });
    const call = async (as: string) =>
      planted.fetch(
        new Request('http://forge.test/planted', { headers: { authorization: `Bearer ${as}` } }),
      );

    let operator = '';
    beforeAll(async () => {
      operator = await userToken((await createTestUser({ verified: true, email: OPERATOR })).id);
    });

    it('names to an operator the shape a per-row loop repeats, with its count and never a bound value', async () => {
      const res = await call(operator);
      expect(res.status).toBe(200);
      const shapes = res.headers.get(STATEMENT_SHAPES_HEADER) ?? '';
      const fp = fingerprintOf(PER_ROW);
      expect(shapes).toBe(`planted-rows: ${fp}*${ROWS}`);
      // the fingerprint turns back into the statement here, with no row's id in it
      expect(shapeTextOf(fp)).toBe('SELECT $n::text AS planted_row_id');
      expect(shapes).not.toMatch(/row-\d/);
    });

    it('sends a person who is not an operator no shape, on the planted read and on Needs you', async () => {
      const res = await call(token);
      expect(res.status).toBe(200);
      expect(res.headers.get('server-timing')).toMatch(/planted-rows;dur=[0-9.]+;desc="8 queries"/);
      expect(res.headers.get(STATEMENT_SHAPES_HEADER)).toBeNull();
      const ny = await api(token, 'GET', `/api/projects/${projectId}/needs-you`);
      expect(ny.status).toBe(200);
      expect(ny.headers.get('server-timing')).toMatch(/ny-requirements;/);
      expect(ny.headers.get(STATEMENT_SHAPES_HEADER)).toBeNull();
    });
  });
});

// ISS-1070 r13: live legs ran ~850 ms over ten statements, a wait nothing named; every outbound
// HTTP call a request waits on is counted and timed, overall and by the provider that made it
describe('the outbound HTTP calls', () => {
  const TOKEN = 'coolify-secret-token';
  let base = '';
  let served = 0;
  const stub = createServer((req, res) => {
    served += 1;
    // each answer takes a while, so a call's time is read in the leg
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(
        String(req.url).startsWith('/commit')
          ? JSON.stringify({ commit: 'abc1234' })
          : JSON.stringify({ count: 0, deployments: [] }),
      );
    }, 30);
  });
  beforeAll(async () => {
    await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    return () => new Promise<void>((done) => stub.close(() => done()));
  });
  const timed = new Hono();
  timed.use(
    '*',
    serverTiming(() => false),
  );
  timed.get('/none', (c) => c.json({ ok: true }));
  timed.get('/calls', async (c) => {
    const coolify = new CoolifyClient({ baseUrl: base, apiToken: TOKEN });
    await withQueryLeg('reads-coolify', () =>
      Promise.all([
        coolify.listApplicationDeployments('app-1', { skip: 0, take: 5 }),
        coolify.listApplicationDeployments('app-2', { skip: 0, take: 5 }),
      ]),
    );
    await readRuntimeProbe({ url: `${base}/commit`, path: 'commit' });
    await (await fetch(`${base}/elsewhere`)).text();
    return c.json({ ok: true });
  });
  const legOf = (raw: string, name: string) => {
    const m = new RegExp(`(?:^|, )${name};dur=([0-9.]+);desc="(\\d+) calls?"`).exec(raw);
    if (!m) throw new Error(`Server-Timing "${raw}" names no ${name} leg`);
    return { ms: Number(m[1]), calls: Number(m[2]) };
  };

  it('names a request that made no call as no calls and no time', async () => {
    const res = await timed.fetch(new Request('http://forge.test/none'));
    expect(legOf(res.headers.get('server-timing') ?? '', 'http')).toEqual({ ms: 0, calls: 0 });
  });

  it('counts and times every call, by the provider that made it, and the part that waited on it', async () => {
    served = 0;
    const res = await timed.fetch(new Request('http://forge.test/calls'));
    expect(res.status).toBe(200);
    const raw = res.headers.get('server-timing') ?? '';
    expect(served).toBe(4);
    const http = legOf(raw, 'http');
    expect(http.calls).toBe(4);
    // two side by side and two in turn: at least three answers' waits, never more than the total
    expect(http.ms).toBeGreaterThanOrEqual(85);
    expect(http.ms).toBeLessThanOrEqual(Number(/total;dur=([0-9.]+)/.exec(raw)?.[1]));
    expect(legOf(raw, 'http-coolify').calls).toBe(2);
    expect(legOf(raw, 'http-coolify').ms).toBeGreaterThanOrEqual(28);
    expect(legOf(raw, 'http-probe').calls).toBe(1);
    expect(legOf(raw, 'http-other').calls).toBe(1);
    expect(raw).toMatch(/reads-coolify;dur=[0-9.]+;desc="0 queries, 2 calls"/);
    // counts and times only: no address, path or credential reaches the header
    expect(raw).not.toMatch(/127\.0\.0\.1|elsewhere|commit|app-1|coolify-secret/);
  });
});
