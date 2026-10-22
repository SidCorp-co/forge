/**
 * A stored credential this server's key cannot open, at every door that reads it (ISS-1259).
 *
 * Planted the way it happens in the field: a secrets record sealed under a key this process does
 * not hold, which is what a rotated or misconfigured INTEGRATION_MASTER_KEY leaves behind.
 */

import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };
type Health = { status: string; message?: string; diagnostics?: Record<string, unknown> };

let harness: TestDatabase;
let app: Hono<AppVars>;
let store: typeof import('../../src/integrations/store.js');
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

const WEBHOOK_SECRET = 'the-binding-signing-secret-at-least-32-chars';
const PLANTED_TOKEN = 'made-up-token-never-to-be-shown-0001';

function sealedUnderAnotherKey(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

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
  await registerIntegrationsForTest();

  store = await import('../../src/integrations/store.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;
  const { integrationsRoutes, integrationConnectionsRoutes } = await import(
    '../../src/integrations/routes.js'
  );
  const { webhookInboundRoutes } = await import('../../src/webhooks/inbound-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<AppVars>();
  app.use('*', requestId());
  app.route('/api/projects', integrationsRoutes);
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.route('/api/webhooks', webhookInboundRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let userId: string;
let projectId: string;
let projectSlug: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  userId = user.id;
  const project = await createTestProject(harness.db, user.id);
  projectId = project.id;
  projectSlug = project.slug;
});

/** A connection and one binding of it, whose stored secrets this server's key cannot open. */
async function plant(
  provider: 'postman' | 'rocketchat' | 'github' | 'coolify',
  opts: { config?: Record<string, unknown>; role?: 'service' | 'deploy' } = {},
) {
  const connection = await store.createConnection({
    ownerType: 'user',
    ownerId: userId,
    provider,
    displayName: `Planted ${provider}`,
    config: opts.config ?? {},
  });
  const sealed = sealedUnderAnotherKey(JSON.stringify({ apiKey: PLANTED_TOKEN }));
  await harness.db.execute(
    sql`UPDATE integration_connections SET secrets_enc = ${sealed} WHERE id = ${connection.id}`,
  );
  const binding = await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider,
    role: opts.role ?? 'service',
    stages: opts.role === 'deploy' ? ['live'] : [],
    integrationSecret: WEBHOOK_SECRET,
  });
  return { connectionId: connection.id, bindingId: binding.id, sealed };
}

const headers = async () => ({
  authorization: `Bearer ${await signUserToken(userId)}`,
  'content-type': 'application/json',
});

async function lastHealth(connectionId: string) {
  const [row] = (await harness.db.execute(sql`
    SELECT last_health_status, last_health_detail, last_health_at
    FROM integration_connections WHERE id = ${connectionId}
  `)) as unknown as Array<{
    last_health_status: string | null;
    last_health_detail: string | null;
    last_health_at: Date | null;
  }>;
  return row;
}

/** Nothing a secret could be recovered from: not the sealed bytes, the key, or the plaintext. */
function expectNothingSecret(text: string, sealed: Buffer) {
  expect(text).not.toContain(PLANTED_TOKEN);
  expect(text).not.toContain(sealed.toString('hex'));
  expect(text).not.toContain(sealed.toString('base64'));
  expect(text).not.toContain(process.env.INTEGRATION_MASTER_KEY as string);
  expect(text).not.toMatch(/Unsupported state|unable to authenticate/);
}

function expectNamed(message: string | undefined, label: string, ids: string[]) {
  expect(message).toContain(`The stored credential of the ${label} connection`);
  for (const id of ids) expect(message).toContain(id);
  expect(message).toContain('could not be decrypted with the key this server holds');
}

describe('a Test of an undecryptable credential', () => {
  it('answers a failed check naming it at the binding Test door, never a 500', async () => {
    const { connectionId, bindingId, sealed } = await plant('postman');
    const res = await app.request(`/api/projects/${projectId}/integrations/${bindingId}/test`, {
      method: 'POST',
      headers: await headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.status).toBe('error');
    expect(body.diagnostics).toMatchObject({
      code: 'credential_unreadable',
      connectionId,
      bindingId,
      provider: 'postman',
    });
    expectNamed(body.message, 'Postman', [connectionId, bindingId]);
    expect(body.message).toContain('Enter the credential again');
    expect(body.message).toContain('INTEGRATION_MASTER_KEY changed');
    expectNothingSecret(JSON.stringify(body), sealed);
  });

  it('answers the same failed check at the connection Test door', async () => {
    const { connectionId, bindingId, sealed } = await plant('postman');
    const res = await app.request(`/api/integration-connections/${connectionId}/test`, {
      method: 'POST',
      headers: await headers(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.status).toBe('error');
    expect(body.diagnostics?.code).toBe('credential_unreadable');
    expectNamed(body.message, 'Postman', [connectionId, bindingId]);
    expectNothingSecret(JSON.stringify(body), sealed);
  });

  it('records the failed check on the connection, so its card reads it', async () => {
    const { connectionId, bindingId, sealed } = await plant('postman');
    await app.request(`/api/projects/${projectId}/integrations/${bindingId}/test`, {
      method: 'POST',
      headers: await headers(),
    });
    const row = await lastHealth(connectionId);
    expect(row?.last_health_status).toBe('error');
    expect(row?.last_health_at).not.toBeNull();
    expectNamed(row?.last_health_detail ?? undefined, 'Postman', [connectionId]);
    expectNothingSecret(row?.last_health_detail ?? '', sealed);
  });

  it('is recorded the same way by the hourly health sweep, not logged as a crashed probe', async () => {
    const { connectionId, sealed } = await plant('postman');
    const { runIntegrationsHealthSweep } = await import('../../src/integrations/health-sweep.js');
    const result = await runIntegrationsHealthSweep();
    expect(result).toMatchObject({ probed: 1, failed: 0 });
    const row = await lastHealth(connectionId);
    expect(row?.last_health_status).toBe('error');
    expectNamed(row?.last_health_detail ?? undefined, 'Postman', [connectionId]);
    expectNothingSecret(row?.last_health_detail ?? '', sealed);
  });
});

describe('a webhook to a binding whose credential cannot be decrypted', () => {
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/desk' } });
  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

  it('is refused 409 CREDENTIAL_UNREADABLE by name, never 500 or handler failed', async () => {
    const { connectionId, bindingId, sealed } = await plant('github');
    const res = await app.request(`/api/webhooks/in/${projectSlug}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
      },
      body,
    });
    expect(res.status).toBe(409);
    const refusal = (await res.json()) as Refusal;
    expect(refusal.code).toBe('CREDENTIAL_UNREADABLE');
    expect(refusal.message).not.toContain('handler failed');
    expectNamed(refusal.message, 'Github', [connectionId, bindingId]);
    expect(refusal.details).toMatchObject({ connectionId, bindingId, provider: 'github' });
    expectNothingSecret(JSON.stringify(refusal), sealed);
  });

  it("is recorded on the binding's delivery log as a turned-away call under that code", async () => {
    const { bindingId } = await plant('github');
    await app.request(`/api/webhooks/in/${projectSlug}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
      },
      body,
    });
    const rows = (await harness.db.execute(sql`
      SELECT status, direction, error_message FROM integration_deliveries
      WHERE binding_id = ${bindingId}::uuid
    `)) as unknown as Array<{ status: string; direction: string; error_message: string }>;
    expect(rows).toEqual([
      { status: 'refused', direction: 'inbound', error_message: 'CREDENTIAL_UNREADABLE' },
    ]);
  });
});

describe('another HTTP door that reads the credential', () => {
  it('refuses 409 CREDENTIAL_UNREADABLE at the Rocket.Chat room list, never a 500', async () => {
    const { connectionId, bindingId, sealed } = await plant('rocketchat', {
      config: { serverUrl: 'http://127.0.0.1:9' },
    });
    const res = await app.request(`/api/projects/${projectId}/integrations/rocketchat/rooms`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ integrationId: bindingId }),
    });
    expect(res.status).toBe(409);
    const refusal = (await res.json()) as Refusal;
    expect(refusal.code).toBe('CREDENTIAL_UNREADABLE');
    expectNamed(refusal.message, 'Rocket.Chat', [connectionId, bindingId]);
    expectNothingSecret(JSON.stringify(refusal), sealed);
  });
});

describe('entering the credential again', () => {
  it('replaces an undecryptable credential at the connection PATCH', async () => {
    const { connectionId } = await plant('postman');
    const res = await app.request(`/api/integration-connections/${connectionId}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ secrets: { apiKey: 'PMAK-made-up-replacement-0001' } }),
    });
    expect(res.status).toBe(200);
    const connection = await store.findConnectionById(connectionId);
    if (!connection) throw new Error('the planted connection is gone');
    expect(store.decryptConnectionSecrets(connection)).toEqual({
      apiKey: 'PMAK-made-up-replacement-0001',
    });
  });

  it('replaces an undecryptable credential at the binding PATCH', async () => {
    const { connectionId, bindingId } = await plant('postman');
    const res = await app.request(`/api/projects/${projectId}/integrations/${bindingId}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ secrets: { apiKey: 'PMAK-made-up-replacement-0002' } }),
    });
    expect(res.status).toBe(200);
    const connection = await store.findConnectionById(connectionId);
    if (!connection) throw new Error('the planted connection is gone');
    expect(store.decryptConnectionSecrets(connection)).toEqual({
      apiKey: 'PMAK-made-up-replacement-0002',
    });
  });

  it('refuses part of a credential over an undecryptable one, saying the whole is owed', async () => {
    const { connectionId, sealed } = await plant('rocketchat', {
      config: { serverUrl: 'http://127.0.0.1:9' },
    });
    const res = await app.request(`/api/integration-connections/${connectionId}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ secrets: { userId: 'made-up-bot-user' } }),
    });
    expect(res.status).toBe(409);
    const refusal = (await res.json()) as Refusal;
    expect(refusal.code).toBe('CREDENTIAL_UNREADABLE');
    expect(refusal.message).toContain('send the whole credential again');
    expectNothingSecret(JSON.stringify(refusal), sealed);
    const [row] = (await harness.db.execute(
      sql`SELECT secrets_enc FROM integration_connections WHERE id = ${connectionId}`,
    )) as unknown as Array<{ secrets_enc: Buffer }>;
    expect(row && Buffer.from(row.secrets_enc).equals(sealed)).toBe(true);
  });

  it('names the binding when part of a credential arrives through the binding PATCH', async () => {
    const { connectionId, bindingId, sealed } = await plant('rocketchat', {
      config: { serverUrl: 'http://127.0.0.1:9' },
    });
    const res = await app.request(`/api/projects/${projectId}/integrations/${bindingId}`, {
      method: 'PATCH',
      headers: await headers(),
      body: JSON.stringify({ secrets: { userId: 'made-up-bot-user' } }),
    });
    expect(res.status).toBe(409);
    const refusal = (await res.json()) as Refusal;
    expect(refusal.code).toBe('CREDENTIAL_UNREADABLE');
    expectNamed(refusal.message, 'Rocket.Chat', [connectionId, bindingId]);
    expect(refusal.details).toMatchObject({ connectionId, bindingId, provider: 'rocketchat' });
    const [row] = (await harness.db.execute(
      sql`SELECT secrets_enc FROM integration_connections WHERE id = ${connectionId}`,
    )) as unknown as Array<{ secrets_enc: Buffer }>;
    expect(row && Buffer.from(row.secrets_enc).equals(sealed)).toBe(true);
  });
});

describe('a reader that is not an HTTP door', () => {
  it('receives the named error from the context every dispatch and inbound read builds', async () => {
    const { connectionId, bindingId, sealed } = await plant('postman');
    const pair = await store.findBindingWithConnectionById(bindingId);
    if (!pair) throw new Error('the planted binding is gone');
    let thrown: unknown;
    try {
      store.buildContextFromBinding(pair);
    } catch (err) {
      thrown = err;
    }
    const { CredentialUnreadable } = await import(
      '../../src/integrations/credential-unreadable.js'
    );
    expect(thrown).toBeInstanceOf(CredentialUnreadable);
    expectNamed((thrown as Error).message, 'Postman', [connectionId, bindingId]);
    expectNothingSecret((thrown as Error).message, sealed);
  });

  it('carries the named message into the deployed-commit reading', async () => {
    const { connectionId, bindingId } = await plant('coolify', { role: 'deploy' });
    const { readForgeDeployments } = await import('../../src/release-batch/deployed-reading.js');
    const reading = await readForgeDeployments(projectId);
    expect(reading.kind).toBe('unanswered');
    const unread = reading.kind === 'unanswered' ? reading.unread.join('\n') : '';
    expectNamed(unread, 'Coolify', [connectionId, bindingId]);
    expect(unread).not.toMatch(/Unsupported state|unable to authenticate/);
  });
});
