import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * ISS-961 — a wave of agent sessions on one PAT, against the whole mounted app.
 *
 * The unit tests in `middleware/require-pat.test.ts` prove the buckets; this
 * file proves the wiring, which is the part that was reported: the class has to
 * be decided by whatever middleware the real route mounts, on real HTTP, or the
 * split is correct in a function nothing calls that way.
 *
 * What it deliberately does NOT do: sleep for a minute. Five clients at one
 * read a second for sixty seconds is 300 requests inside one 60s window, and
 * this issues the same 300 concurrently — the same charge against the same
 * bucket in less of the window, which is strictly harsher. The literal
 * wall-clock version was run once by hand and is cited on the issue.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let issueId: string;
let userId: string;
let token: string;
let resetPatBuckets: () => void;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  // cm:guard the read ceiling is pinned to 600 — the single shared bucket ISS-961 replaced — and may be LOWERED but never raised. Draining it is how the write-after-drain test tells two buckets from one, so a ceiling above 600 lets that test pass against a single bucket, and a drain longer than `windowMs` refills the bucket mid-test: at the stock 2400 the drain measured 62.5s against a 60s window on CI and asserted 200 where it wanted 429.
  process.env.RATE_LIMIT_PAT_READ_MAX = '600';
  delete process.env.RATE_LIMIT_PAT_WRITE_MAX;
  delete process.env.RATE_LIMIT_PAT_READ_WINDOW_MS;
  delete process.env.RATE_LIMIT_PAT_WRITE_WINDOW_MS;

  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  userId = user.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);
  const project = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectId = project.id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id });

  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 'wave probe', 'open', ${user.id})
  `);

  const { mintPat } = await import('../../src/auth/pat.js');
  token = (await mintPat({ userId: user.id, name: 'the-box' })).plaintext;

  ({ app } = await import('../../src/index.js'));
  ({ __resetPatBuckets: resetPatBuckets } = await import('../../src/middleware/require-pat.js'));
});

afterAll(async () => {
  await harness.cleanup();
});

const auth = (t = token) => ({ authorization: `Bearer ${t}` });

const read = (t = token) => app.request(`/api/projects/${projectId}/issues`, { headers: auth(t) });

const write = (t = token) =>
  app.request(`/api/issues/${issueId}`, {
    method: 'PATCH',
    headers: { ...auth(t), 'content-type': 'application/json' },
    body: JSON.stringify({ priority: 'low' }),
  });

describe('a wave of sessions on one token', () => {
  it('serves five sessions worth of reads in one window with no refusal', async () => {
    resetPatBuckets();
    const SESSIONS = 5;
    const READS_EACH = 60;

    const perSession = await Promise.all(
      Array.from({ length: SESSIONS }, async () => {
        const statuses: number[] = [];
        for (let i = 0; i < READS_EACH; i += 1) statuses.push((await read()).status);
        return statuses;
      }),
    );

    const all = perSession.flat();
    expect(all).toHaveLength(SESSIONS * READS_EACH);
    expect(all.filter((s) => s === 429)).toEqual([]);
    expect(all.every((s) => s === 200)).toBe(true);
  }, 60_000);

  // cm:guard the falsifying half of the file. Everything else here passes for the single shared bucket ISS-961 replaced; only a write served AFTER the read budget is spent tells two buckets from one, and it is what the report asked for in the words "a wave's reads never delay its writes".
  it('still serves a write after the reads have spent their whole budget', async () => {
    resetPatBuckets();
    const { RULES } = await import('../../src/config/rate-limits.js');

    const batch = 200;
    for (let sent = 0; sent < RULES.patRead.max; sent += batch) {
      const size = Math.min(batch, RULES.patRead.max - sent);
      await Promise.all(Array.from({ length: size }, () => read()));
    }
    const refused = await read();
    expect(refused.status).toBe(429);

    const served = await write();
    expect(served.status).not.toBe(429);
  }, 120_000);

  it('tells the client how long to wait, in the header and in the body', async () => {
    resetPatBuckets();
    const { RULES } = await import('../../src/config/rate-limits.js');

    const batch = 200;
    for (let sent = 0; sent < RULES.patWrite.max + 1; sent += batch) {
      const size = Math.min(batch, RULES.patWrite.max + 1 - sent);
      await Promise.all(Array.from({ length: size }, () => write()));
    }
    const refused = await write();
    expect(refused.status).toBe(429);

    const retryAfter = Number(refused.headers.get('Retry-After'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers.get('X-RateLimit-Scope')).toBe('write');

    const body = (await refused.json()) as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details).toMatchObject({
      retryAfterSeconds: retryAfter,
      windowSeconds: 60,
      limit: RULES.patWrite.max,
      remaining: 0,
      scope: 'write',
    });

    expect((await read()).status).toBe(200);
  }, 120_000);

  it('charges a GET to the read bucket and a PATCH to the write bucket, on real routes', async () => {
    resetPatBuckets();
    const { RULES } = await import('../../src/config/rate-limits.js');

    const gotRead = await read();
    expect(gotRead.headers.get('X-RateLimit-Scope')).toBe('read');
    expect(gotRead.headers.get('X-RateLimit-Limit')).toBe(String(RULES.patRead.max));

    const gotWrite = await write();
    expect(gotWrite.headers.get('X-RateLimit-Scope')).toBe('write');
    expect(gotWrite.headers.get('X-RateLimit-Limit')).toBe(String(RULES.patWrite.max));

    const reset = Number(gotRead.headers.get('X-RateLimit-Reset'));
    expect(reset).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  /**
   * The one that found the real magnitude of the reported defect.
   *
   * Every router self-gates with `use('*', requireAuth(), …)` so it cannot be
   * mounted unguarded, and Hono runs the middleware of every router whose
   * prefix matches. On `GET /api/projects/:id/issues` that is nine of them, and
   * each used to verify the token and charge the bucket again — so the real
   * ceiling was the stated one divided by nine, and 600 refused a token after
   * 66 requests while reporting 600.
   */
  // cm:guard this asserts an EXACT decrement, not "at most a few". A tolerance is what let nine charges look like one for as long as nobody read `X-RateLimit-Remaining`, and the number is the property: one request, one charge.
  // cm:guard exact decrements demand a bucket no other test can charge, so this mints its OWN PAT — buckets are keyed by PAT, and the module token's buckets still carry in-flight charges from the wave tests above that resetPatBuckets() cannot cancel, which read back here as phantom decrements (off-by-two under the full suite, green in isolation).
  it('charges the bucket exactly once per request, however many routers gate the path', async () => {
    const { mintPat } = await import('../../src/auth/pat.js');
    const solo = (await mintPat({ userId, name: 'exact-charge-probe' })).plaintext;
    const { RULES } = await import('../../src/config/rate-limits.js');

    const first = await read(solo);
    expect(Number(first.headers.get('X-RateLimit-Remaining'))).toBe(RULES.patRead.max - 1);
    const second = await read(solo);
    expect(Number(second.headers.get('X-RateLimit-Remaining'))).toBe(RULES.patRead.max - 2);

    const firstWrite = await write(solo);
    expect(Number(firstWrite.headers.get('X-RateLimit-Remaining'))).toBe(RULES.patWrite.max - 1);
    const secondWrite = await write(solo);
    expect(Number(secondWrite.headers.get('X-RateLimit-Remaining'))).toBe(RULES.patWrite.max - 2);
  });

  it('charges an MCP read to the read bucket and an MCP write to the write bucket', async () => {
    resetPatBuckets();
    const { RULES } = await import('../../src/config/rate-limits.js');

    const rpc = (body: unknown) =>
      app.request('/mcp', {
        method: 'POST',
        headers: {
          ...auth(),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      });

    const listed = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(listed.headers.get('X-RateLimit-Scope')).toBe('read');
    expect(listed.headers.get('X-RateLimit-Limit')).toBe(String(RULES.patRead.max));

    const mutated = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'forge_comments', arguments: { action: 'create' } },
    });
    expect(mutated.headers.get('X-RateLimit-Scope')).toBe('write');
    expect(mutated.headers.get('X-RateLimit-Limit')).toBe(String(RULES.patWrite.max));
  });
});
