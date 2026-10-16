/**
 * ISS-1421 — Forge's own account writes what Forge's sweeps say, and is never shown as a person.
 *
 * It is an agent account in no organization, so every people surface that reads membership leaves it
 * out by construction. What this file holds is that nothing puts it there and nothing counts it: no
 * member list, collaborator list, mention, notification or sign-in reaches it, and the one door that
 * adds an existing account by email refuses it by name.
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

const FORGE_EMAIL = 'forge@agents.forge.invalid';

let harness: TestDatabase;
let server: TestServer;
let forge: typeof import('../../src/comments/forge-author.js');
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
  forge = await import('../../src/comments/forge-author.js');
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  const project = await createTestProject(harness.db, ownerId);
  projectId = project.id;
  orgId = project.orgId;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(ownerId);
  const { db } = await import('../../src/db/client.js');
  await forge.forgeAuthorId(db);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/** Every id and address a people read answers with, however deep it sits. */
async function peopleIn(path: string): Promise<string> {
  const res = await call(path);
  expect(res.status).toBe(200);
  return JSON.stringify(await res.json());
}

describe("Forge's account is never shown or counted as a person (ISS-1421)", () => {
  it('is in no member list, collaborator list or member count', async () => {
    for (const path of [
      `/api/orgs/${orgId}/members`,
      `/api/projects/${projectId}/members`,
      '/api/me/collaborators',
    ]) {
      const said = await peopleIn(path);
      expect(said).not.toContain(forge.FORGE_AUTHOR_ID);
      expect(said).not.toContain(FORGE_EMAIL);
    }
    const [counted] = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM organization_members WHERE user_id = ${forge.FORGE_AUTHOR_ID}
    `);
    expect(counted?.n).toBe(0);
  });

  it('is refused by name where an org admin adds an existing account by its address', async () => {
    const res = await call(`/api/orgs/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: FORGE_EMAIL, role: 'member' }),
    });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('FORGE_IS_NOT_A_MEMBER');
    const direct = await call(`/api/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: forge.FORGE_AUTHOR_ID, role: 'member' }),
    });
    expect(direct.status).toBe(409);
    expect(await peopleIn(`/api/orgs/${orgId}/members`)).not.toContain(forge.FORGE_AUTHOR_ID);
  });

  it('reads as an agent named Forge where it filed an issue, never as a person', async () => {
    await harness.db.execute(sql`
      INSERT INTO issues (project_id, title, created_by_id, status, iss_seq)
      VALUES (${projectId}, 'Filed by Forge', ${forge.FORGE_AUTHOR_ID}, 'open', 1)
    `);
    const said = (await (await call(`/api/projects/${projectId}/issues`)).json()) as {
      items?: Array<Record<string, unknown>>;
    };
    const filed = (said.items ?? (said as unknown as Array<Record<string, unknown>>)).find(
      (i) => i.title === 'Filed by Forge',
    );
    expect(filed).toMatchObject({ creatorIsAgent: true, creatorLabel: 'Forge' });
  });

  it('is never mentioned and never told anything', async () => {
    const { resolveMentions } = await import('../../src/comments/mentions.js');
    expect(await resolveMentions(['forge'], projectId)).toEqual([]);

    const { emitNotification } = await import('../../src/notifications/emit.js');
    const told = await emitNotification({
      recipients: [forge.FORGE_AUTHOR_ID, ownerId],
      projectId,
      type: 'mention',
      title: 'a mention',
    });
    expect(told?.delivered).toBe(1);
    const [reached] = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notification_deliveries WHERE user_id = ${forge.FORGE_AUTHOR_ID}
    `);
    expect(reached?.n).toBe(0);
  });

  it('cannot sign in, holding no password and being an agent', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: FORGE_EMAIL, password: 'Any-password-1421!' }),
    });
    expect(res.status).toBe(401);
    const [stored] = await harness.db.execute<{ password_hash: string | null; kind: string }>(sql`
      SELECT password_hash, kind FROM users WHERE id = ${forge.FORGE_AUTHOR_ID}
    `);
    expect(stored).toEqual({ password_hash: null, kind: 'agent' });
  });
});
