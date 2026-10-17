/**
 * ISS-1421 round 3 — no door that adds a person adds an agent address or an agent account.
 *
 * Judge-29 invited someagent@agents.forge.invalid to a project and was answered 201, an invitation
 * that could never be accepted, since registering at that address is refused. Every door that adds a
 * person is driven here with an address on the agent domain in mixed case, before and after an
 * account holds it, and the rows are read back: project invite, project direct-add, org add-member,
 * and both invitation accepts. Forge's own address keeps its own code (forge-not-a-member-e2e).
 * Real Postgres, the whole server.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const AGENT_SHOUTED = 'SomeAgent@Agents.Forge.INVALID';

let harness: TestDatabase;
let server: TestServer;
let token: string;
let ownerId: string;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  const project = await createTestProject(harness.db, owner.id);
  projectId = project.id;
  orgId = project.orgId;
  await harness.db.execute(sql`UPDATE organizations SET is_personal = false WHERE id = ${orgId}`);
  await harness.db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${owner.id}, 'owner')
    ON CONFLICT DO NOTHING
  `);
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  token = await tokenFor(owner.id);
});

async function tokenFor(userId: string): Promise<string> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return signUserToken(userId);
}

async function post(path: string, body: unknown, bearer = token): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = await harness.db.execute<{ n: number }>(query);
  return Number(row?.n ?? 0);
}

async function refusedAsAgent(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe('AGENT_ADDRESS_RESERVED');
  expect(body.message).toMatch(
    /agent account, not a person's\.|is an agent account Forge mints, not a person\./,
  );
  expect(body.message).toContain('No person can be invited or added as it.');
  expect(body.message).toContain('Settings → Agents');
}

/** An account at the agent domain: an agent Forge minted, or one registered before the domain was refused. */
async function accountAt(kind: 'agent' | 'human'): Promise<string> {
  const user = await createTestUser(harness.db, {
    email: AGENT_SHOUTED.toLowerCase(),
    kind,
    emailVerifiedAt: new Date(),
  });
  return user.id;
}

describe.each([
  ['no account holds it', null],
  ['an agent account holds it', 'agent'],
] as const)('an agent address is never invited or added, while %s (criteria 42, 44)', (_, held) => {
  beforeEach(async () => {
    if (held) await accountAt(held);
  });

  it('is refused by the project invitation door, in any letter case, and no invitation is made', async () => {
    await refusedAsAgent(
      await post(`/api/projects/${projectId}/members/invite`, {
        email: AGENT_SHOUTED,
        role: 'member',
      }),
    );
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM project_invitations WHERE project_id = ${projectId}`,
      ),
    ).toBe(0);
  });

  it('is refused by the org member door, in any letter case, and neither a member nor an invitation is made', async () => {
    await refusedAsAgent(
      await post(`/api/orgs/${orgId}/members`, { email: AGENT_SHOUTED, role: 'member' }),
    );
    expect(
      await count(sql`SELECT count(*)::int AS n FROM org_invitations WHERE org_id = ${orgId}`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM organization_members WHERE org_id = ${orgId}`),
    ).toBe(1);
  });
});

describe('an agent account is never added to a project by the person door (criterion 43)', () => {
  it('is refused by name, and no membership is made', async () => {
    const agent = await accountAt('agent');
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${agent}, 'member')
    `);

    await refusedAsAgent(
      await post(`/api/projects/${projectId}/members`, { userId: agent, role: 'member' }),
    );
    expect(
      await count(sql`SELECT count(*)::int AS n FROM project_members WHERE user_id = ${agent}`),
    ).toBe(0);
  });

  it('still adds a person the org already has', async () => {
    const person = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    await harness.db.execute(sql`
      INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${person.id}, 'member')
    `);
    const res = await post(`/api/projects/${projectId}/members`, {
      userId: person.id,
      role: 'member',
    });
    expect(res.status).toBe(201);
  });
});

describe('an account at an agent address accepts no invitation (criterion 45)', () => {
  const expires = () => new Date(Date.now() + 86_400_000).toISOString();

  it('is refused at the project invitation accept, and the invitation stays unaccepted', async () => {
    const holder = await accountAt('human');
    const invite = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES (${invite}, ${projectId}, ${AGENT_SHOUTED.toLowerCase()}, 'member', ${ownerId}, ${expires()})
    `);

    await refusedAsAgent(
      await post(`/api/invitations/${invite}/accept`, {}, await tokenFor(holder)),
    );
    expect(
      await count(sql`SELECT count(*)::int AS n FROM project_members WHERE user_id = ${holder}`),
    ).toBe(0);
    expect(
      await count(sql`
        SELECT count(*)::int AS n FROM project_invitations WHERE token = ${invite} AND accepted_at IS NULL
      `),
    ).toBe(1);
  });

  it('is refused at the org invitation accept, and the invitation stays unaccepted', async () => {
    const holder = await accountAt('human');
    const invite = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO org_invitations (token, org_id, email, role, inviter_id, expires_at)
      VALUES (${invite}, ${orgId}, ${AGENT_SHOUTED.toLowerCase()}, 'member', ${ownerId}, ${expires()})
    `);

    await refusedAsAgent(
      await post(`/api/org-invitations/${invite}/accept`, {}, await tokenFor(holder)),
    );
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${holder}`,
      ),
    ).toBe(0);
    expect(
      await count(sql`
        SELECT count(*)::int AS n FROM org_invitations WHERE token = ${invite} AND accepted_at IS NULL
      `),
    ).toBe(1);
  });

  it('still lets a person accept their own invitation', async () => {
    const person = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    const invite = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES (${invite}, ${projectId}, ${person.email}, 'member', ${ownerId}, ${expires()})
    `);
    const res = await post(`/api/invitations/${invite}/accept`, {}, await tokenFor(person.id));
    expect(res.status).toBe(200);
  });
});
