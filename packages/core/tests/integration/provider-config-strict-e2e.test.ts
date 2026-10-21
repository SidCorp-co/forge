/**
 * ISS-1421 r18, criterion 171 — judge-75 on beta 1201ef4: a Coolify binding sent
 * `targets[0].healthURL` (meant `healthUrl`), `colour` and `resourceUUID` answered 200 or 201 and
 * kept none of them. Through the composed app and its own error handler, against real Postgres:
 * each door refuses the stray field by name, points at the field near it, and writes nothing.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let token: string;
let projectId: string;

const target = { label: 'web', resourceUuid: 'app-uuid-1' };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  await registerIntegrationsForTest();
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  token = await (await import('../../src/auth/jwt.js')).signUserToken(owner.id);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function send(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const create = (config: Record<string, unknown>) =>
  send('POST', `/api/projects/${projectId}/integrations`, {
    provider: 'coolify',
    role: 'deploy',
    stages: ['live'],
    config: { baseUrl: 'https://coolify.example.com', targets: [target], ...config },
    secrets: { apiToken: 'a-token-of-length' },
  });

async function bindings() {
  const r = await send('GET', `/api/projects/${projectId}/integrations`);
  return (r.body.items ?? []) as Array<{ id: string; config?: Record<string, unknown> }>;
}

describe('a provider config field the provider does not take, at the REST doors', () => {
  it('is refused at create, naming the field near it inside an array entry, and nothing is bound', async () => {
    const r = await create({
      colour: 'red',
      targets: [{ ...target, healthURL: 'https://h.example.com/health' }],
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('The field config.colour is not one this call takes.');
    expect(r.body.message).toContain(
      'The field config.targets.0.healthURL is not one this call takes. This call takes config.targets.0.healthUrl, which may be what config.targets.0.healthURL meant.',
    );
    expect(await bindings()).toEqual([]);
  });

  it('is refused on a binding PATCH and on a connection PATCH, writing no part of either', async () => {
    const made = await create({});
    expect(made.status).toBe(201);
    const [binding] = await bindings();
    if (!binding) throw new Error('the binding was not created');
    const stored = async () =>
      (
        await harness.db.execute<{ binding: unknown; connection: unknown; connection_id: string }>(
          sql`SELECT b.config AS binding, c.config AS connection, b.connection_id
                FROM integration_bindings b JOIN integration_connections c ON c.id = b.connection_id
               WHERE b.id = ${binding.id}`,
        )
      )[0];
    const before = await stored();
    if (!before) throw new Error('the binding has no stored config');

    // Each refused PATCH carries a well-formed change beside its stray field: a door that wrote the
    // part it could read before refusing the rest would change what is stored.
    const patch = await send('PATCH', `/api/projects/${projectId}/integrations/${binding.id}`, {
      config: {
        targets: [
          { label: 'api', resourceUuid: 'app-uuid-2', healthURL: 'https://h.example.com/h' },
        ],
      },
    });
    expect(patch.status).toBe(400);
    expect(patch.body.message).toBe(
      'The field config.targets.0.healthURL is not one this call takes. This call takes config.targets.0.healthUrl, which may be what config.targets.0.healthURL meant.',
    );

    const connPatch = await send('PATCH', `/api/integration-connections/${before.connection_id}`, {
      config: { baseUrl: 'https://other.example.com', colour: 'red' },
    });
    expect(connPatch.status).toBe(400);
    expect(connPatch.body.message).toBe('The field config.colour is not one this call takes.');

    expect(await stored()).toEqual(before);
  });
});
