/**
 * The speaker-link routes refuse as `{ code, error }`, which the API reference declares as its own
 * shape rather than the error envelope. The integration run checks each JSON answer against that
 * declaration, so a refusal in any other shape comes back as a conformance 500 here (ISS-1371).
 */

import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as { app: Hono });
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function signedIn(): Promise<string> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return signUserToken(user.id);
}

describe('unlinking a chat speaker', () => {
  it('refuses a source Forge does not know as { code, error }, unchanged', async () => {
    const jwt = await signedIn();
    const res = await app.request('/api/me/speaker-links/nowhere/ns/someone', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'SPEAKER_SOURCE_UNKNOWN',
      error: expect.any(String),
    });
  });

  it('refuses a speaker the caller holds no link for as { code, error }, unchanged', async () => {
    const jwt = await signedIn();
    const res = await app.request('/api/me/speaker-links/telegram/ns/someone', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'SPEAKER_UNLINKED', error: expect.any(String) });
  });
});
