/**
 * ISS-1229 r22 — judge-63 saved an address as a display name and it was taken: the person saw the
 * address as their name while every other member read "Another member", and nothing said why. A
 * display name holding an address is now refused, with the one sentence the Settings field shows.
 */

import { displayNameRefusal } from '@forge/contracts/person-name';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let userId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now(), display_name = 'Mai Tran' WHERE id = ${userId}`,
  );
});

async function setName(displayName: string | null): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request('/api/auth/me', {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName }),
  });
}

async function storedName(): Promise<string | null> {
  const rows = await harness.db.execute<{ display_name: string | null }>(
    sql`SELECT display_name FROM users WHERE id = ${userId}`,
  );
  return rows[0]?.display_name ?? null;
}

describe('a display name holding an email address', () => {
  it.each(['mai@example.com', 'Mai <mai@example.com>'])(
    'is refused with the sentence that says why, and the stored name stays (%j)',
    async (typed) => {
      const res = await setName(typed);
      const body = (await res.json()) as { code?: string; message?: string };

      expect(res.status).toBe(400);
      expect(body.code).toBe('DISPLAY_NAME_HOLDS_AN_ADDRESS');
      expect(body.message).toBe(displayNameRefusal(typed));
      expect(await storedName()).toBe('Mai Tran');
    },
  );

  it('leaves a name holding none, and clearing the name, as they were', async () => {
    expect((await setName('Lan Pham')).status).toBe(200);
    expect(await storedName()).toBe('Lan Pham');
    expect((await setName(null)).status).toBe(200);
    expect(await storedName()).toBeNull();
  });
});
