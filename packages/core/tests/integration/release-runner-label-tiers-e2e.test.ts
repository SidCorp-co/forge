/**
 * ISS-1275 — the two acts `RELEASE_RUNNER_PREFERENCE_UNMET` offers, taken through
 * the routes the screens use, and read back as what the project's readiness says
 * rather than as what the request carried.
 *
 * Both PATCHes merge and then withdraw nulls, so a key sent as null is REMOVED rather
 * than stored. The connection route stored one until ISS-1275, which left a withdrawn
 * label on the row for ever; the stored shape is asserted below rather than inferred
 * from the readiness the case reads back.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { PRODUCTION_PROBE, seedProduction, stubProbe } from '../helpers/production.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err, registry, connections, bindings] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
    import('../../src/integrations/register-all.js'),
    import('../../src/integrations/connection-routes.js'),
    import('../../src/integrations/routes.js'),
  ]);
  registry.registerAllIntegrations();
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.route('/api/projects', bindings.integrationsRoutes);
  app.route('/api/integration-connections', connections.integrationConnectionsRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  stubProbe({ [PRODUCTION_PROBE]: () => Response.json({ commit: 'commit-live' }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface World {
  projectId: string;
  userId: string;
  connectionId: string;
  bindingId: string;
  token: string;
}

async function seed(tiers: {
  binding?: string | undefined;
  connection?: string | undefined;
}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(
    sql`UPDATE projects SET repo_url = 'git@github.com:acme/app.git' WHERE id = ${project.id}`,
  );
  const { bindingId, connectionId } = await seedProduction(harness.db, {
    projectId: project.id,
    ownerId: user.id,
    connectionConfig: tiers.connection ? { releaseRunnerLabel: tiers.connection } : {},
    config: {
      rollback: { mode: 'coolify-image' },
      ...(tiers.binding ? { releaseRunnerLabel: tiers.binding } : {}),
    },
    deploysFrom: 'production',
  });
  const device = await createTestDevice(harness.db, user.id, { status: 'online' });
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'unlabelled',
            'online', now(), '[]'::jsonb)
  `);
  return {
    projectId: project.id,
    userId: user.id,
    connectionId,
    bindingId,
    token: await signUserToken(user.id),
  };
}

/** The label the unmet-preference reading names, which is what a clearing moves. */
async function preferredLabel(w: World): Promise<string | null> {
  const res = await app.request(`/api/projects/${w.projectId}/release-readiness`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  const body = (await res.json()) as {
    warnings: Array<{ code: string; details?: Record<string, unknown> }>;
  };
  const warned = body.warnings.find((x) => x.code === 'RELEASE_RUNNER_PREFERENCE_UNMET');
  return (warned?.details?.label as string | undefined) ?? null;
}

function patch(path: string, token: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function storedConfig(
  w: World,
  tier: 'binding' | 'connection',
): Promise<Record<string, unknown>> {
  const rows =
    tier === 'binding'
      ? await harness.db.execute<{ config: Record<string, unknown> }>(
          sql`SELECT config FROM integration_bindings WHERE id = ${w.bindingId}`,
        )
      : await harness.db.execute<{ config: Record<string, unknown> }>(
          sql`SELECT config FROM integration_connections WHERE id = ${w.connectionId}`,
        );
  return rows[0]?.config ?? {};
}

describe('clearing the release runner label through the route each tier is edited on', () => {
  it('takes the binding tier out, and the preference with it', async () => {
    const w = await seed({ binding: 'release' });
    const before = await preferredLabel(w);

    const done = await patch(`/api/projects/${w.projectId}/integrations/${w.bindingId}`, w.token, {
      config: { releaseRunnerLabel: null },
    });

    expect(before).toBe('release');
    expect(done.status).toBe(200);
    expect(await preferredLabel(w)).toBeNull();
    expect('releaseRunnerLabel' in (await storedConfig(w, 'binding'))).toBe(false);
  });

  // The caveat the sentence carries, reproduced: the binding's key goes and the
  // connection's is uncovered rather than the preference ending.
  it('uncovers the connection tier where only the binding is taken out', async () => {
    const w = await seed({ binding: 'release', connection: 'other' });
    const before = await preferredLabel(w);

    await patch(`/api/projects/${w.projectId}/integrations/${w.bindingId}`, w.token, {
      config: { releaseRunnerLabel: null },
    });

    expect(before).toBe('release');
    expect(await preferredLabel(w)).toBe('other');
  });

  it('takes the connection tier out, and the preference with it', async () => {
    const w = await seed({ connection: 'other' });
    const before = await preferredLabel(w);

    const done = await patch(`/api/integration-connections/${w.connectionId}`, w.token, {
      config: { releaseRunnerLabel: null },
    });

    expect(before).toBe('other');
    expect(done.status).toBe(200);
    expect(await preferredLabel(w)).toBeNull();
    expect('releaseRunnerLabel' in (await storedConfig(w, 'connection'))).toBe(false);
  });

  it('keeps a connection key the patch did not name', async () => {
    const w = await seed({ connection: 'other' });
    await harness.db.execute(sql`
      UPDATE integration_connections
         SET config = config || ${JSON.stringify({
           baseUrl: 'https://coolify.example.test',
         })}::jsonb
       WHERE id = ${w.connectionId}
    `);

    const done = await patch(`/api/integration-connections/${w.connectionId}`, w.token, {
      config: { releaseRunnerLabel: null },
    });

    expect(done.status).toBe(200);
    expect((await storedConfig(w, 'connection')).baseUrl).toBe('https://coolify.example.test');
  });

  it('refuses a connection patch whose base url is not a url, by name', async () => {
    const w = await seed({ connection: 'other' });

    const refused = await patch(`/api/integration-connections/${w.connectionId}`, w.token, {
      config: { baseUrl: 'not-a-url' },
    });

    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain('baseUrl');
    expect(await preferredLabel(w)).toBe('other');
  });
});
