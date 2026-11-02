/**
 * The two declaration forms ISS-824 part 15 adds, through the app against real Postgres: an
 * instance-admin route is refused at the door, ADMIN_ONLY, to a signed-in person off the admin list
 * and answered for one on it, with no check left in its handler; and a route declared by a named
 * rule with a floor is refused at the door below the floor, while one with no floor is answered by
 * its own rule.
 *
 * @direct-test-of packages/core/src/admin/routes.ts
 * @direct-test-of packages/core/src/admin/aggregate-routes.ts
 * @direct-test-of packages/core/src/outbox/routes.ts
 * @direct-test-of packages/core/src/instance-settings/routes.ts
 * @direct-test-of packages/core/src/permissions/declared.ts
 * @direct-test-of packages/core/src/release-batch/routes.ts
 * @direct-test-of packages/core/src/ecosystem/channel-routes.ts
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

const OPERATOR = 'operator@declared-admin.test';
// env is read once, on first use: the operator list is set before anything imports it
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = 'operator@declared-admin.test';
});

import { api, type Body, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

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

describe('a route declared by a named rule with a floor (POST release-batches)', () => {
  it('refuses a caller with no role at the door, naming the floor, before the cut rule runs', async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const refused = await api(
      tokens.person,
      'POST',
      `/api/projects/${project.id}/release-batches`,
      {
        issueIds: [],
      },
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    // the floor's own answer: requireMasterAct alone would name project.admin
    expect(JSON.stringify(refused.body)).toContain('project.read');
    expect(JSON.stringify(refused.body)).not.toContain('project.admin');
  });
});

describe('a route declared by a named rule with no floor (the channel)', () => {
  it("answers a no-role caller's inbox read by the role rule's own detail, which no door check replaces", async () => {
    const owner = (await createTestUser({ verified: true })).id;
    const project = await createTestProject(owner);
    const refused = await api(tokens.person, 'GET', `/api/projects/${project.id}/channel/inbox`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('holds no role on project');
  });
});
