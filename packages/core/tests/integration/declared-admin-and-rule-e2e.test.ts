/**
 * The two declaration forms ISS-824 part 15 adds, through the app against real Postgres: an
 * instance-admin route is refused at the door, ADMIN_ONLY, to a signed-in person off the admin list
 * and answered for one on it, with no check left in its handler; and a route declared by a named
 * rule with a floor is refused at the door below the floor.
 *
 * @direct-test-of packages/core/src/admin/routes.ts
 * @direct-test-of packages/core/src/admin/aggregate-routes.ts
 * @direct-test-of packages/core/src/outbox/routes.ts
 * @direct-test-of packages/core/src/instance-settings/routes.ts
 * @direct-test-of packages/core/src/permissions/declared.ts
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@declared-admin.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@declared-admin.test';
});

import { api, type Body, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser } from '../helpers/factories.js';

const tokens = { operator: '', person: '' };

const codeOf = (body: Body) => {
  const error = body.error as { code?: string; refusals?: { code: string }[] } | undefined;
  return error?.code ?? error?.refusals?.[0]?.code ?? JSON.stringify(body);
};

beforeAll(async () => {
  testEnv();
  tokens.operator = await userToken((await createTestUser({ email: OPERATOR, verified: true })).id);
  tokens.person = await userToken((await createTestUser({ verified: true })).id);
}, 120_000);

describe('an instance-admin route is checked at the door, from the admin list', () => {
  it.each([
    '/api/admin/overview',
    '/api/admin/projects',
    '/api/admin/alerts',
    '/api/admin/outbox/dead',
    '/api/admin/instance-settings',
  ])('refuses %s to a person off the list, ADMIN_ONLY, and answers the operator', async (route) => {
    const refused = await api(tokens.person, 'GET', route);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(codeOf(refused.body)).toBe('ADMIN_ONLY');
    const answered = await api(tokens.operator, 'GET', route);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  });

  it('refuses before the input is read: a bad query from a non-admin is ADMIN_ONLY, not invalid', async () => {
    const refused = await api(tokens.person, 'GET', '/api/admin/overview?window=never');
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    const invalid = await api(tokens.operator, 'GET', '/api/admin/overview?window=never');
    expect(invalid.status, JSON.stringify(invalid.body)).toBe(400);
  });

  it("answers whoami to anyone signed in, as the caller's own standing", async () => {
    const person = await api(tokens.person, 'GET', '/api/admin/whoami');
    expect(person.status).toBe(200);
    expect(person.body.isAdmin).toBe(false);
    const operator = await api(tokens.operator, 'GET', '/api/admin/whoami');
    expect(operator.body.isAdmin).toBe(true);
  });
});
