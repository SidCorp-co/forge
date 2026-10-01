/**
 * The Coolify deploy commands over REST.
 *
 * `/api/projects` is on the PAT allowlist, so these are what `forge-runner api`
 * reaches with a job token — which is the point of them existing at all, and is
 * what the first case pins.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;

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

  const [routes, errMod, reqIdMod, pat] = await Promise.all([
    import('../../src/integrations/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/pat.js'),
  ]);
  mintPat = pat.mintPat;
  // Any route ending in notifyConnectionChanged reads the provider registry.
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/projects', routes.integrationsRoutes);
  app.onError(errMod.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}::uuid`,
  );
  const { plaintext } = await mintPat({
    userId: user.id,
    name: 'cli token',
    boundProjectId: project.id,
  });
  return { user, project, token: plaintext };
}

/** A binding of either role, inserted straight in — the create route needs credentials. */
async function seedBinding(projectId: string, role: 'deploy' | 'service') {
  const { randomUUID } = await import('node:crypto');
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', (SELECT created_by FROM projects WHERE id = ${projectId}::uuid),
            'coolify', '{}'::jsonb, NULL, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, config, active)
    VALUES (${bindingId}, ${connectionId}, ${projectId}::uuid, 'coolify', ${role}, '{}'::jsonb, true)
  `);
  return bindingId;
}

const call = (
  token: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown,
) =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('Coolify commands over REST', () => {
  it('lists with a personal access token, not just a browser session', async () => {
    const { project, token } = await seed();
    const res = await call(token, `/api/projects/${project.id}/integrations/coolify`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ integrations: [] });
  });

  it('reports nothing to deploy rather than failing, when no integration exists', async () => {
    const { project, token } = await seed();
    const res = await call(
      token,
      `/api/projects/${project.id}/integrations/coolify/deploy`,
      'POST',
      {},
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dispatched: false, reason: 'no-integration' });
  });

  it('refuses a project the token cannot see', async () => {
    const { token } = await seed();
    const stranger = await createTestUser(harness.db);
    const other = await createTestProject(harness.db, stranger.id);

    const res = await call(token, `/api/projects/${other.id}/integrations/coolify`);
    expect([403, 404]).toContain(res.status);
  });

  it('reports nothing to cancel rather than failing, when no integration exists', async () => {
    const { project, token } = await seed();
    const res = await call(
      token,
      `/api/projects/${project.id}/integrations/coolify/cancel`,
      'POST',
      {},
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'project has no active Coolify integration',
    });
  });

  it('refuses a rollback with no image named, before resolving any integration', async () => {
    const { project, token } = await seed();
    const res = await call(
      token,
      `/api/projects/${project.id}/integrations/coolify/rollback`,
      'POST',
      {},
    );
    expect(res.status).toBe(400);
  });

  it('refuses an applications probe that carries neither a binding nor a credential', async () => {
    const { project, token } = await seed();
    const res = await call(
      token,
      `/api/projects/${project.id}/integrations/coolify/applications`,
      'POST',
      { baseUrl: 'https://coolify.example' },
    );
    expect(res.status).toBe(400);
  });

  it('refuses to read the targets of a project with no integration', async () => {
    const { project, token } = await seed();
    const res = await call(token, `/api/projects/${project.id}/integrations/coolify/targets`);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed deploy body instead of deploying something else', async () => {
    const { project, token } = await seed();
    const res = await call(
      token,
      `/api/projects/${project.id}/integrations/coolify/deploy`,
      'POST',
      { issueId: 'not-a-uuid' },
    );
    expect(res.status).toBe(400);
  });
});

// ISS-8 — the environment a deploy binding serves is the project document's, so a PATCH naming
// `stages` is refused by name on either role, and nothing is written.
describe('a binding PATCH naming stages', () => {
  it.each(['deploy', 'service'] as const)(
    'is refused by name on a %s binding, pointing at the project document',
    async (role) => {
      const { project, token } = await seed();
      const id = await seedBinding(project.id, role);

      const res = await call(token, `/api/projects/${project.id}/integrations/${id}`, 'PATCH', {
        stages: ['live'],
      });

      expect(res.status).toBe(400);
      const text = JSON.stringify(await res.json());
      expect(text).toContain('a binding carries no `stages`');
      expect(text).toContain('PUT /api/projects/:id/config');
      const rows = await harness.db.execute<{ revision: number }>(
        sql`SELECT revision FROM integration_bindings WHERE id = ${id}::uuid`,
      );
      expect((rows[0] as { revision: number }).revision).toBe(1);
    },
  );
});
