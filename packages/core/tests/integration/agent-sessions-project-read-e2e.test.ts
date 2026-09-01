/**
 * ISS-894 — `/api/projects/:id/agent-sessions` exists so a project-scoped token
 * has somewhere to read session data. `GET /api/agent-sessions` cannot be that
 * place: its no-`projectId` branch fans out across every visible project, which
 * is why the prefix is off the PAT allowlist.
 *
 * A route that takes both a project id and a session id can be got wrong in one
 * specific way — trusting the path instead of the row — so that is what this
 * drives against a real database: a member of one project naming their own
 * project in the path while asking for someone else's session.
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

describe('project-scoped agent-session reads', () => {
  let harness: TestDatabase;
  let app: Hono;
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

    const { agentSessionProjectReadRoutes } = await import(
      '../../src/agent-sessions/project-read-routes.js'
    );
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono();
    app.use('*', requestId());
    app.route('/api/projects', agentSessionProjectReadRoutes);
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function member(): Promise<{ userId: string; token: string; projectId: string }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'member',
    });
    return {
      userId: user.id,
      token: await signUserToken(user.id),
      projectId: project.id,
    };
  }

  async function seedSession(projectId: string, messages: unknown[] = []): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${null}, 'system', 'completed', now())
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, messages, created_at, updated_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'completed',
        ${JSON.stringify(messages)}::jsonb, now(), now())
    `);
    return sessionId;
  }

  const get = (path: string, token: string) =>
    app.request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });

  it('lists only the named project’s sessions', async () => {
    const a = await member();
    const other = await createTestProject(harness.db, a.userId);
    await seedSession(a.projectId);
    await seedSession(a.projectId);
    await seedSession(other.id);

    const res = await get(`/api/projects/${a.projectId}/agent-sessions`, a.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(2);
  });

  it('refuses a caller who is not a member', async () => {
    const owner = await member();
    const stranger = await member();
    await seedSession(owner.projectId);

    const res = await get(`/api/projects/${owner.projectId}/agent-sessions`, stranger.token);
    expect(res.status).toBe(403);
  });

  // cm:guard this is the assertion the route exists to satisfy: the project must come from `row.projectId`, never from the path. Delete the `row.projectId !== id` check and this is the only test that notices — the membership check above still passes, because the caller really IS a member of the project they named.
  it('will not serve another project’s session to a member who names their own', async () => {
    const a = await member();
    const b = await member();
    const foreign = await seedSession(b.projectId, [{ role: 'user', content: 'secret' }]);

    const res = await get(`/api/projects/${a.projectId}/agent-sessions/${foreign}`, a.token);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });

  it('returns a session that does belong to the named project, tail-truncated', async () => {
    const a = await member();
    const messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const id = await seedSession(a.projectId, messages);

    const res = await get(`/api/projects/${a.projectId}/agent-sessions/${id}`, a.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { messages: unknown[]; totalMessages: number };
    };
    expect(body.session.totalMessages).toBe(25);
    expect(body.session.messages).toHaveLength(20);
    expect(body.session.messages[0]).toEqual({ role: 'user', content: 'm5' });
  });
});
