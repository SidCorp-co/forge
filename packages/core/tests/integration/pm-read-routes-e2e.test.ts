/**
 * The three PM reads over REST — snapshot, graph, runner load.
 *
 * ISS-894: `forge_project_pm` is the highest-traffic tool of the heavy block
 * and three of its six actions had no route at all. These run against real
 * Postgres because all three are joins over issues/jobs/runners that a stubbed
 * drizzle would answer without ever executing.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

  const [pm, jwt, err] = await Promise.all([
    import('../../src/pm/read-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', pm.pmReadRoutes);
  app.onError(err.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function verifiedUser() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { user, token: await signUserToken(user.id) };
}

async function seed() {
  const { user, token } = await verifiedUser();
  const project = await createTestProject(harness.db, user.id);
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${project.id}, 1, 'pm fixture', 'open', ${user.id})`);
  return { user, token, project, issueId };
}

const get = (path: string, token: string) =>
  app.request(path, { headers: { authorization: `Bearer ${token}` } });

describe('PM reads over REST', () => {
  it.each([['snapshot'], ['graph'], ['runner-load']])('serves %s to a member', async (leaf) => {
    const { project, token } = await seed();
    const res = await get(`/api/projects/${project.id}/pm/${leaf}`, token);
    expect(res.status).toBe(200);
  });

  // cm:guard a NON-MEMBER, not merely an anonymous caller: every one of these reads returns the shape of a project's work — its issues, its dependency graph, what its runners are carrying. `assertProjectRole(access, 'viewer')` is the only thing between a signed-in stranger and that, and a 401-only test would pass with the membership check deleted.
  it.each([['snapshot'], ['graph'], ['runner-load']])(
    'refuses a signed-in stranger on %s',
    async (leaf) => {
      const { project } = await seed();
      const stranger = await verifiedUser();
      const res = await get(`/api/projects/${project.id}/pm/${leaf}`, stranger.token);
      expect(res.status).toBe(403);
    },
  );

  it('lets a plain member read, not just an admin', async () => {
    const { project } = await seed();
    const mate = await verifiedUser();
    await createTestOrgMember(harness.db, {
      orgId: project.orgId,
      userId: mate.user.id,
      role: 'member',
    });
    await createTestProjectMember(harness.db, {
      userId: mate.user.id,
      projectId: project.id,
      role: 'viewer',
    });

    expect((await get(`/api/projects/${project.id}/pm/snapshot`, mate.token)).status).toBe(200);
  });

  // cm:guard the depth cap is enforced by the ROUTE schema, not left to the service — `readPmGraph` takes depth as a plain number, so an uncapped route hands it straight to a recursive BFS and a caller picks the cost of the query.
  it('refuses a graph depth past the cap', async () => {
    const { project, token } = await seed();
    expect((await get(`/api/projects/${project.id}/pm/graph?depth=99`, token)).status).toBe(400);
  });

  it('walks from a root issue when one is named', async () => {
    const { project, token, issueId } = await seed();
    const res = await get(`/api/projects/${project.id}/pm/graph?rootIssueId=${issueId}`, token);
    expect(res.status).toBe(200);
  });

  it('refuses an unauthenticated caller', async () => {
    const { project } = await seed();
    expect((await app.request(`/api/projects/${project.id}/pm/snapshot`)).status).toBe(401);
  });
});
