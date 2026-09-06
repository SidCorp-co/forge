// Reading a connection and managing it are two different permissions, and the
// gap between them is exactly one principal: the org member who is not an
// admin. The directory lists an org credential to every member, so a member
// who then asks which projects use it must get an answer — gating that READ on
// the manage check answered 404 for a card the same request had just returned.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

describe('connection reads gate on visibility, writes on admin', () => {
  let harness: TestDatabase;
  let app: Hono<AppVars>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.NODE_ENV = 'test';

    const { integrationConnectionsRoutes } = await import(
      '../../src/integrations/connection-routes.js'
    );
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono<AppVars>();
    app.use('*', requestId());
    app.route('/api/integration-connections', integrationConnectionsRoutes);
    app.onError(errorHandler);
  });

  afterAll(async () => harness.cleanup());
  beforeEach(async () => truncateAll(harness.db));

  async function seedOrgConnection() {
    const owner = await verified();
    const member = await verified();
    const org = await seedOrg(harness.db, owner.id);
    await createTestOrgMember(harness.db, { orgId: org.id, userId: member.id, role: 'member' });

    const connectionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, config)
      VALUES (${connectionId}, 'org', ${org.id}, 'coolify', '{}'::jsonb)
    `);
    return { owner, member, org, connectionId };
  }

  const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  async function verified() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    return user;
  }

  it('answers the bindings read for a plain org member, who already sees the card', async () => {
    const { member, connectionId } = await seedOrgConnection();
    const res = await app.request(
      `/api/integration-connections/${connectionId}/bindings`,
      auth(await signUserToken(member.id)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('still refuses that member the WRITE, and says forbidden rather than not-found', async () => {
    const { member, connectionId } = await seedOrgConnection();
    const res = await app.request(`/api/integration-connections/${connectionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'renamed by a member' }),
      headers: {
        authorization: `Bearer ${await signUserToken(member.id)}`,
        'content-type': 'application/json',
      },
    });
    expect(res.status).toBe(403);
  });

  it('tells a non-member nothing at all — not-found, never forbidden', async () => {
    const { connectionId } = await seedOrgConnection();
    const outsider = await verified();
    const res = await app.request(
      `/api/integration-connections/${connectionId}/bindings`,
      auth(await signUserToken(outsider.id)),
    );
    expect(res.status).toBe(404);
  });

  it('keeps another user’s personal credential invisible to the read as well', async () => {
    const stranger = await verified();
    const reader = await verified();
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, config)
      VALUES (${connectionId}, 'user', ${stranger.id}, 'coolify', '{}'::jsonb)
    `);
    const res = await app.request(
      `/api/integration-connections/${connectionId}/bindings`,
      auth(await signUserToken(reader.id)),
    );
    expect(res.status).toBe(404);
  });
});
