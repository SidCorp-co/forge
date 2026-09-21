/**
 * The reproduction in ISS-1129's body, at the door it was reported on: an agent
 * asks `closed` on an issue already standing at `awaiting_release`, on a project
 * whose release gate rewrites that close. The builder raises `NO_OP`; what this
 * pins is the sentence surviving to the caller as an HTTP body.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let mintPat: typeof import('../../src/auth/pat.js')['mintPat'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [transitionMod, patMod, errMod] = await Promise.all([
    import('../../src/issues/transition.js'),
    import('../../src/auth/pat.js'),
    import('../../src/middleware/error.js'),
  ]);
  mintPat = patMod.mintPat;
  app = new Hono();
  app.route('/api/issues', transitionMod.transitionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

/** A project that is GATED: a release model, and a live deploy binding to carry it. */
async function seedGatedProject() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  // The whole point of the case: agency is read off the user holding the
  // credential (ISS-1137), so the PAT below is an AGENT's and the release gate
  // rewrites its close.
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now(), kind = 'agent' WHERE id = ${user.id}::uuid`,
  );
  await harness.db.execute(
    sql`UPDATE projects SET release_model = 'publish', base_branch = 'main' WHERE id = ${project.id}::uuid`,
  );

  const connectionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${user.id}::uuid, 'coolify', '{}'::jsonb, NULL, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (id, connection_id, project_id, provider, role, stages, config, active)
    VALUES (${randomUUID()}, ${connectionId}, ${project.id}::uuid, 'coolify', 'deploy',
            '{live}'::text[], '{}'::jsonb, true)
  `);

  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'an agent holding a token',
    boundProjectId: project.id,
  });
  return { user, project, token: plaintext };
}

async function insertIssue(projectId: string, userId: string, status: string) {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status)
    VALUES (${projectId}::uuid, 'the one already at the gate', ${userId}::uuid, ${status})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

const transition = (id: string, token: string, toStatus: string) =>
  app.request(`/api/issues/${id}/transition`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ toStatus }),
  });

describe('POST /api/issues/:id/transition — a NO_OP the release gate caused', () => {
  it('answers with the sentence naming the gate and both ways to `closed`', async () => {
    const { user, project, token } = await seedGatedProject();
    const id = await insertIssue(project.id, user.id, 'awaiting_release');

    const res = await transition(id, token, 'closed');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('NO_OP');
    const said = body.message ?? '';
    expect(said).toContain('release gate');
    expect(said).toContain(`POST /api/projects/${project.id}/release-batches`);
    expect(said).toContain(`POST /api/projects/${project.id}/release-records`);
    expect(said).not.toBe('issue already in toStatus');
  });

  it('still says the plain thing where the gate rewrote nothing', async () => {
    const { user, project, token } = await seedGatedProject();
    const id = await insertIssue(project.id, user.id, 'in_progress');

    const res = await transition(id, token, 'in_progress');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('NO_OP');
    expect(body.message).toContain('already in status in_progress');
    expect(body.message).not.toContain('release gate');
  });
});
