/**
 * The generic inbound door verifies against the project secret `secret://project/webhook-secret`,
 * resolved from the vault. A project that has not stored one is refused by name, never verified
 * against an empty key.
 */

import { createHmac, randomBytes } from 'node:crypto';
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
let service: typeof import('../../src/project-config/service.js');

const SECRET = 'the-project-webhook-secret-at-least-32-chars';
const body = JSON.stringify({ event: 'ping' });
const sign = (secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.INTEGRATION_MASTER_KEY ??= randomBytes(32).toString('base64');
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [routes, errMod, svc] = await Promise.all([
    import('../../src/webhooks/inbound-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/project-config/service.js'),
  ]);
  service = svc;
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  app = new Hono<{ Variables: RequestIdVars }>();
  app.route('/api/webhooks', routes.webhookInboundRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let project: { id: string; slug: string };

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  project = await createTestProject(harness.db, user.id);
});

function deliver(signature: string) {
  return app.request(`/api/webhooks/in/${project.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-signature-256': signature },
    body,
  });
}

describe('POST /api/webhooks/in/:slug · the generic door reads its secret from the vault', () => {
  it('refuses with SECRET_VALUE_MISSING, naming the secret, where the project stores none', async () => {
    const res = await deliver(sign(''));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('SECRET_VALUE_MISSING');
    expect(text).toContain('secret://project/webhook-secret');
  });

  it('accepts a delivery signed with the stored project secret', async () => {
    await service.putSecret({
      projectId: project.id,
      scope: 'project',
      name: 'webhook-secret',
      value: SECRET,
    });
    const res = await deliver(sign(SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: true, handler: 'generic' });
  });

  it('refuses a delivery signed with any other key, with INVALID_SIGNATURE', async () => {
    await service.putSecret({
      projectId: project.id,
      scope: 'project',
      name: 'webhook-secret',
      value: SECRET,
    });
    const res = await deliver(sign('some-other-secret-of-the-same-length-xxxx'));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('INVALID_SIGNATURE');
  });
});
