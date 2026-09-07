/**
 * ISS-959 A — a `sessionContext` write may carry the value it read, and is
 * refused when the field moved.
 *
 * This runs against a real Postgres because the whole rule IS the SQL: the
 * precondition is a term in the UPDATE's own WHERE (`IS NOT DISTINCT FROM` a
 * jsonb parameter), and a fake query builder cannot tell that apart from a
 * read-then-write, which is the exact race the rule closes. The unit suite
 * (`src/issues/update-service.test.ts`) never executes a `where`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

describe('ISS-959 A — conditional sessionContext write', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const [routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/issues/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      issueRoutes: routesMod.issueRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };
    app = new Hono();
    app.route('/api/issues', mods.issueRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed(sessionContext?: Record<string, unknown>) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
      VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)}, 'lease', 'open',
              ${user.id}, ${sessionContext ? JSON.stringify(sessionContext) : null}::jsonb)
    `);
    const token = await mods.signUserToken(user.id);
    return { id, token };
  }

  function patch(id: string, token: string, body: unknown) {
    return app.request(`/api/issues/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  async function storedContext(id: string): Promise<unknown> {
    const rows = await harness.db.execute<{ session_context: unknown }>(
      sql`SELECT session_context FROM issues WHERE id = ${id}`,
    );
    return (rows[0] as { session_context: unknown }).session_context;
  }

  const leaseA = { lease: { holder: 'session-a', pid: '1' } };
  const leaseB = { lease: { holder: 'session-b', pid: '2' } };

  it('AC1 — a write with no `expect` stores the value, exactly as before this change', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, { sessionContext: leaseB });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC2 — the first writer carrying the value it read stores its own value', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC3/AC4/AC8 — the second writer holding the same read value is refused 409 with the value the first stored, and stores nothing', async () => {
    const { id, token } = await seed(leaseA);
    const first = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(first.status).toBe(200);

    const loser = { lease: { holder: 'session-c', pid: '3' } };
    const second = await patch(id, token, {
      sessionContext: loser,
      expect: { sessionContext: leaseA },
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      code: string;
      details: { current: unknown };
      message: string;
    };
    expect(body.code).toBe('SESSION_CONTEXT_MISMATCH');
    expect(body.details.current).toEqual(leaseB);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC5 — `expect: { sessionContext: null }` succeeds while the field holds no value', async () => {
    const { id, token } = await seed();
    const res = await patch(id, token, {
      sessionContext: leaseA,
      expect: { sessionContext: null },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseA);
  });

  it('AC6 — `expect: { sessionContext: null }` is refused while the field holds a value', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: null },
    });
    expect(res.status).toBe(409);
    expect(await storedContext(id)).toEqual(leaseA);
  });

  it('AC7 — an `expect` differing only in key order is accepted', async () => {
    const stored = { lease: { holder: 'session-a', pid: '1' }, branch: 'ISS-959' };
    const { id, token } = await seed(stored);
    const reordered = { branch: 'ISS-959', lease: { pid: '1', holder: 'session-a' } };
    const res = await patch(id, token, {
      sessionContext: leaseB,
      expect: { sessionContext: reordered },
    });
    expect(res.status).toBe(200);
    expect(await storedContext(id)).toEqual(leaseB);
  });

  it('AC10 — an `expect` on an issue id that does not exist is not-found, never a mismatch', async () => {
    const { token } = await seed(leaseA);
    const res = await patch(randomUUID(), token, {
      sessionContext: leaseB,
      expect: { sessionContext: leaseA },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });

  it('refuses an `expect` sent with no field to write — a compare-and-set that writes nothing is a read wearing a write verb', async () => {
    const { id, token } = await seed(leaseA);
    const res = await patch(id, token, { expect: { sessionContext: leaseA } });
    expect(res.status).toBe(400);
  });

  it('holds the precondition against a write of ANOTHER field the lease covers', async () => {
    const { id, token } = await seed(leaseA);
    const refused = await patch(id, token, {
      plan: 'the plan',
      expect: { sessionContext: leaseB },
    });
    expect(refused.status).toBe(409);

    const accepted = await patch(id, token, {
      plan: 'the plan',
      expect: { sessionContext: leaseA },
    });
    expect(accepted.status).toBe(200);
    const rows = await harness.db.execute<{ plan: string | null }>(
      sql`SELECT plan FROM issues WHERE id = ${id}`,
    );
    expect((rows[0] as { plan: string | null }).plan).toBe('the plan');
  });

  it('two concurrent writers on the same read value: exactly one wins', async () => {
    const { id, token } = await seed(leaseA);
    const [one, two] = await Promise.all([
      patch(id, token, { sessionContext: leaseB, expect: { sessionContext: leaseA } }),
      patch(id, token, {
        sessionContext: { lease: { holder: 'session-c', pid: '3' } },
        expect: { sessionContext: leaseA },
      }),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
