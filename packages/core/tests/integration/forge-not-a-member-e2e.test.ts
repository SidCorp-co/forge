/**
 * ISS-1421 round 2 — no door makes Forge a member or invites it, and no person can hold its address.
 *
 * Judge-28 invited forge@agents.forge.invalid to a project and was answered 201, the invitation then
 * listed as pending: the one door that refused Forge was the org's, and only once Forge's account
 * existed. Every door that adds a person by address or by id is driven here, with the address in
 * mixed case and before and after Forge's account is minted, and the rows read back. Registration
 * is driven too, since an account registered at that address first would be the one Forge's sweeps
 * then could not mint. Real Postgres, the whole server.
 */

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

const FORGE_SHOUTED = 'Forge@Agents.Forge.INVALID';

let harness: TestDatabase;
let server: TestServer;
let forge: typeof import('../../src/comments/forge-author.js');
let token: string;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
  forge = await import('../../src/comments/forge-author.js');
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const project = await createTestProject(harness.db, owner.id);
  projectId = project.id;
  orgId = project.orgId;
  await harness.db.execute(sql`UPDATE organizations SET is_personal = false WHERE id = ${orgId}`);
  await harness.db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${owner.id}, 'owner')
    ON CONFLICT DO NOTHING
  `);
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(owner.id);
});

async function mintForge(): Promise<void> {
  const { db } = await import('../../src/db/client.js');
  await forge.forgeAuthorId(db);
}

async function post(path: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = await harness.db.execute<{ n: number }>(query);
  return Number(row?.n ?? 0);
}

async function refusedAsForge(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe('FORGE_IS_NOT_A_MEMBER');
  expect(body.message).toContain("is Forge's own account");
}

describe.each([
  ['before', false],
  ['after', true],
])('Forge is never invited or added, %s its account exists (criteria 32, 33, 34)', (_, minted) => {
  beforeEach(async () => {
    if (minted) await mintForge();
  });

  it('is refused by the project invitation door, in any letter case, and no invitation is made', async () => {
    await refusedAsForge(
      await post(`/api/projects/${projectId}/members/invite`, {
        email: FORGE_SHOUTED,
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
    await refusedAsForge(
      await post(`/api/orgs/${orgId}/members`, { email: FORGE_SHOUTED, role: 'member' }),
    );
    expect(
      await count(sql`SELECT count(*)::int AS n FROM org_invitations WHERE org_id = ${orgId}`),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${forge.FORGE_AUTHOR_ID}`,
      ),
    ).toBe(0);
  });

  it('is refused by name by the project direct-add door, and no membership is made', async () => {
    await refusedAsForge(
      await post(`/api/projects/${projectId}/members`, {
        userId: forge.FORGE_AUTHOR_ID,
        role: 'member',
      }),
    );
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM project_members WHERE user_id = ${forge.FORGE_AUTHOR_ID}`,
      ),
    ).toBe(0);
  });
});

describe('no person holds an address Forge mints (criterion 35)', () => {
  it.each([FORGE_SHOUTED, 'reviewer.0a1b2c3d4e5f@agents.forge.invalid'])(
    'refuses registering %s, and no account is made',
    async (email) => {
      const res = await post(
        '/api/auth/register',
        { email, password: 'a long passphrase nobody guesses 4821' },
        false,
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('AGENT_ADDRESS_RESERVED');
      expect(body.message).toContain('belongs to an agent account Forge mints');
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM users WHERE lower(email) = ${email.toLowerCase()}`,
        ),
      ).toBe(0);
    },
  );

  it('still registers an ordinary address', async () => {
    const res = await post(
      '/api/auth/register',
      { email: 'a.person@example.com', password: 'a long passphrase nobody guesses 4821' },
      false,
    );
    expect(res.status).toBe(201);
  });
});
