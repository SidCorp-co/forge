import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * The gate on `/mcp` is mounted with `use`, which matches every method: without a token even a
 * method the router never heard of is refused 401, so an unauthenticated probe is green whether
 * or not the method is registered. Past the gate the router answers, and PUT holds the 404.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let token: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';

  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  await seedOrg(harness.db, user.id);
  const { mintPat } = await import('../../src/auth/pat.js');
  token = (await mintPat({ userId: user.id, name: 'mcp-routing-probe' })).plaintext;
  ({ app } = await import('../../src/index.js'));
});

afterAll(async () => {
  await harness?.cleanup();
});

function probe(method: string) {
  return app.request('/mcp', { method, headers: { authorization: `Bearer ${token}` } });
}

describe('the /mcp registration in the composition root', () => {
  for (const method of ['POST', 'GET', 'DELETE']) {
    it(`still routes ${method} to a handler`, async () => {
      const res = await probe(method);
      expect(res.status).not.toBe(404);
    });
  }

  it('answers 404 for a method it never registered, so the three above can fail', async () => {
    const res = await probe('PUT');
    expect(res.status).toBe(404);
  });
});
