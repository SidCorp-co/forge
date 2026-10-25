/**
 * ISS-1421 r27 — judge-110: GitHub sends a person's browser back to setup_url, an API address, so a
 * refusal there (an unreadable App, no App owning the install) was JSON in their tab. A browser that
 * asks for a page lands on the web's page instead; any other caller keeps the API's answer.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestUser, setupTestDatabase, type TestDatabase } from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let token: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const user = await createTestUser(harness.db, { email: `landing-${randomUUID().slice(0, 6)}@test.forge.local` });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  token = await signUserToken(user.id);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const installed = (accept: string, bearer: string | null = token) =>
  app.request('/api/integrations/github/installed?installation_id=424242', {
    headers: { accept, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  });

describe("GitHub's return to setup_url (the master's ruling on judge-110 (a))", () => {
  it('lands a browser on the web page that words the refusal, by its code', async () => {
    const res = await installed('text/html,application/xhtml+xml');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${process.env.APP_BASE_URL}/integrations/github/landed?code=NOT_FOUND`,
    );
  });

  it('lands a signed-out browser on the same page', async () => {
    const res = await installed('text/html', null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/\/integrations\/github\/landed\?code=UNAUTHENTICATED$/);
  });

  it('keeps the API answer for a caller that does not ask for a page', async () => {
    const res = await installed('application/json');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });
});
