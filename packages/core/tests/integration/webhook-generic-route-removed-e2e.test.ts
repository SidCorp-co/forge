/**
 * `POST /api/webhooks/in/:slug` takes only a provider's webhook. The generic delivery — one naming
 * no provider header — verified its signature and then reached nothing, so it is refused 410 by
 * name, before any project is read, and a provider's webhook at the same address still verifies.
 */

import { createHmac, randomUUID } from 'node:crypto';
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

const SECRET = 'the-binding-signing-secret-at-least-32-chars';
const body = JSON.stringify({ event: 'ping' });
const sign = (secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

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

  const [routes, errMod] = await Promise.all([
    import('../../src/webhooks/inbound-routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  app = new Hono<{ Variables: RequestIdVars }>();
  app.route('/api/webhooks', routes.webhookInboundRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let slug: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  slug = project.slug;
  const connectionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${user.id}::uuid, 'github', '{}'::jsonb, NULL, true)
  `);
  await harness.db.execute(sql`
    INSERT INTO integration_bindings
      (id, connection_id, project_id, provider, role, config, active, integration_secret)
    VALUES (${randomUUID()}, ${connectionId}, ${project.id}::uuid, 'github', 'service',
            '{}'::jsonb, true, ${SECRET})
  `);
});

function deliver(to: string, headers: Record<string, string>) {
  return app.request(`/api/webhooks/in/${to}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('POST /api/webhooks/in/:slug · the generic delivery is removed', () => {
  it.each([
    ['a signed generic delivery', { 'x-forge-signature-256': sign(SECRET) }],
    ['a hub-signed delivery naming no provider', { 'x-hub-signature-256': sign(SECRET) }],
    ['an unsigned one', {}],
  ])('refuses %s 410 WEBHOOK_ROUTE_REMOVED, naming the provider webhooks', async (_, headers) => {
    const res = await deliver(slug, headers);
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('WEBHOOK_ROUTE_REMOVED');
    expect(text).toContain('x-github-event (github)');
  });

  it('refuses before reading the project, so a slug that names none answers the same', async () => {
    const res = await deliver('no-such-project', { 'x-forge-signature-256': sign(SECRET) });
    expect(res.status).toBe(410);
  });

  it("still verifies a provider's webhook at the same address against its binding", async () => {
    const res = await deliver(slug, {
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign('not-the-binding-secret-of-the-same-size!'),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('INVALID_SIGNATURE');
  });
});
