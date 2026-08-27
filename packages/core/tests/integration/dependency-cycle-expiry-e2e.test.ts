import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type DependencyRoutesModule = typeof import('../../src/issues/dependency-routes.js');
type JwtModule = typeof import('../../src/auth/jwt.js');
type ErrorModule = typeof import('../../src/middleware/error.js');

type Mods = {
  issueDependencyRoutes: DependencyRoutesModule['issueDependencyRoutes'];
  signUserToken: JwtModule['signUserToken'];
  errorHandler: ErrorModule['errorHandler'];
};

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
    import('../../src/issues/dependency-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    issueDependencyRoutes: routesMod.issueDependencyRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/issues', mods.issueDependencyRoutes);
  app.onError(mods.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

it('allows the reverse edge after the earlier blocker has expired', async () => {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const a = await insertIssue(project.id, user.id);
  const b = await insertIssue(project.id, user.id);
  const token = await mods.signUserToken(user.id);

  const expired = await app.request(`/api/issues/${b}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      dependsOnId: a,
      validUntil: '2020-01-01T00:00:00.000Z',
    }),
  });
  expect(expired.status).toBe(201);

  const reverse = await app.request(`/api/issues/${a}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ dependsOnId: b }),
  });
  expect(reverse.status).toBe(201);
});

it('retracts an existing edge when validUntil is supplied again', async () => {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const blocker = await insertIssue(project.id, user.id);
  const dependent = await insertIssue(project.id, user.id);
  const token = await mods.signUserToken(user.id);

  const created = await app.request(`/api/issues/${dependent}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ dependsOnId: blocker }),
  });
  expect(created.status).toBe(201);

  const retracted = await app.request(`/api/issues/${dependent}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      dependsOnId: blocker,
      validUntil: '2020-01-01T00:00:00.000Z',
    }),
  });
  expect(retracted.status).toBe(200);
  expect(await retracted.json()).toMatchObject({ created: false, updated: true });

  const [edge] = await harness.db.execute<{ valid_until: string }>(sql`
    SELECT valid_until FROM issue_dependencies
    WHERE from_issue_id = ${blocker} AND to_issue_id = ${dependent}
  `);
  expect(Date.parse(edge?.valid_until ?? '')).toBeLessThan(Date.now());
});

it('rejects a new active blocks edge whose source issue is dropped', async () => {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const dropped = await insertIssue(project.id, user.id, 'dropped');
  const dependent = await insertIssue(project.id, user.id);
  const token = await mods.signUserToken(user.id);

  const response = await app.request(`/api/issues/${dependent}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ dependsOnId: dropped }),
  });

  expect(response.status).toBe(400);
});

it('allows expiring an existing edge after its blocker is dropped', async () => {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const blocker = await insertIssue(project.id, user.id);
  const dependent = await insertIssue(project.id, user.id);
  const token = await mods.signUserToken(user.id);

  const created = await app.request(`/api/issues/${dependent}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ dependsOnId: blocker }),
  });
  expect(created.status).toBe(201);
  await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${blocker}`);

  const expired = await app.request(`/api/issues/${dependent}/dependencies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ dependsOnId: blocker, validUntil: '2020-01-01T00:00:00.000Z' }),
  });

  expect(expired.status).toBe(200);
  expect(await expired.json()).toMatchObject({ created: false, updated: true });
});

it('serializes concurrent opposite blocks edges', async () => {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const first = await insertIssue(project.id, user.id);
  const second = await insertIssue(project.id, user.id);
  const token = await mods.signUserToken(user.id);
  await installCycleInsertBarrier();

  const responses = await Promise.all([
    app.request(`/api/issues/${second}/dependencies`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ dependsOnId: first }),
    }),
    app.request(`/api/issues/${first}/dependencies`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ dependsOnId: second }),
    }),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  const [edge] = await harness.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM issue_dependencies
    WHERE kind = 'blocks' AND project_id = ${project.id}
  `);
  expect(edge).toEqual({ count: '1' });
  await removeCycleInsertBarrier();
});

async function insertIssue(projectId: string, ownerId: string, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)}, 'Issue', ${status}, ${ownerId})
  `);
  return id;
}

async function installCycleInsertBarrier(): Promise<void> {
  await harness.db.execute(sql`
    CREATE FUNCTION dependency_cycle_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('dependency-cycle-insert-barrier'));
      PERFORM pg_sleep(0.5);
      RETURN NEW;
    END;
    $$
  `);
  await harness.db.execute(sql`
    CREATE TRIGGER dependency_cycle_insert_barrier
    BEFORE INSERT ON issue_dependencies
    FOR EACH ROW EXECUTE FUNCTION dependency_cycle_insert_barrier()
  `);
}

async function removeCycleInsertBarrier(): Promise<void> {
  await harness.db.execute(sql`DROP TRIGGER dependency_cycle_insert_barrier ON issue_dependencies`);
  await harness.db.execute(sql`DROP FUNCTION dependency_cycle_insert_barrier()`);
}

function authHeaders(token: string) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}
