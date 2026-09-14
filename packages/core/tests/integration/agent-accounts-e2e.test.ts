/**
 * ISS-1003 — an agent has a name you can read, an address you can type, and a
 * credential that says it is the one speaking.
 *
 * Every claim here is about a real Postgres because every one of them is about
 * something the DATABASE refuses or records: a unique index over two columns on
 * two different tables, a CHECK, a migration that aborts rather than renames,
 * and a token whose liveness is `now()` on the server. A mocked `db` would
 * assert the mock — the whole point of moving the handle into a column was that
 * the rule stopped being an assertion a writer makes and became one Postgres
 * makes.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let accounts: typeof import('../../src/orgs/agent-accounts.js');
let pat: typeof import('../../src/auth/pat.js');
let handles: typeof import('../../src/conversations/handles.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  accounts = await import('../../src/orgs/agent-accounts.js');
  pat = await import('../../src/auth/pat.js');
  handles = await import('../../src/conversations/handles.js');
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let orgA: string;
let orgB: string;
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  const a = await createTestProject(harness.db, ownerId, {
    slug: `alpha-${randomUUID().slice(0, 8)}`,
  });
  const b = await createTestProject(harness.db, ownerId, {
    slug: `beta-${randomUUID().slice(0, 8)}`,
  });
  orgA = a.orgId;
  orgB = b.orgId;
  projectA = a.id;
  projectB = b.id;
});

describe('the handle is a column, and the database is what keeps it unique', () => {
  it('records the handle on the membership rather than leaving it in the address', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId: orgA,
      projectId: projectA,
      handle: 'forge-dev',
    });
    const [row] = await harness.db.execute<{ handle: string }>(
      sql`SELECT handle FROM organization_members WHERE user_id = ${agent.userId}`,
    );
    expect(row?.handle).toBe('forge-dev');
    expect((await accounts.listAgentAccounts(orgA))[0]?.handle).toBe('forge-dev');
  });

  // cm:guard the refusal must come from POSTGRES and not from a caller, so this writes the duplicate row with RAW SQL, around every service in this repo: a service-level check would pass a test that went through `createAgentAccount` and still let any other writer — a migration, a fixture, psql — put two `@forge-dev`s in one org. Drop `organization_members_org_handle_uniq` and this is what goes red.
  it('refuses a second agent of the same name in one org, by constraint, whoever writes it', async () => {
    const { agent } = await accounts.createAgentAccount({
      orgId: orgA,
      projectId: projectA,
      handle: 'forge-dev',
    });
    const other = await createTestUser(harness.db);
    const refusal = await harness.db
      .execute(
        sql`INSERT INTO organization_members (org_id, user_id, role, handle)
            VALUES (${orgA}, ${other.id}, 'member', 'forge-dev')`,
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(refusal).not.toBeNull();
    expect(JSON.stringify(refusal)).toContain('organization_members_org_handle_uniq');
    expect((await accounts.listAgentAccounts(orgA))[0]?.userId).toBe(agent.userId);
    expect(await accounts.listAgentAccounts(orgA)).toHaveLength(1);
  });

  // cm:guard a room minting a handle is the OTHER writer of this column, and its insert must abort on the collision rather than skip it. `onConflictDoNothing` there is the shape that looks safe and is not: the only conflict a freshly created user can reach is this index, so swallowing it commits an agent holding a project membership and NO org membership, and the room then fails later at `loadHandle` with `HANDLE_HAS_NO_NAME` — a message about the wrong thing entirely, in a transaction that already succeeded. Found by review, F2. Restore `onConflictDoNothing()` on the membership insert in `resolveProjectHandle` and this goes red.
  it('aborts a room’s own handle mint on the collision instead of committing a nameless agent', async () => {
    const slug = `gamma-${randomUUID().slice(0, 8)}`;
    const project = await createTestProject(harness.db, ownerId, { slug, orgId: orgA });
    await accounts.createAgentAccount({ orgId: orgA, projectId: projectA, handle: slug });

    const before = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users`,
    );
    const refusal = await harness.db
      .transaction((tx) => handles.resolveProjectHandle(tx as never, project.id))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(refusal).not.toBeNull();
    expect(JSON.stringify(refusal)).toContain('organization_members_org_handle_uniq');
    const after = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users`,
    );
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    const agentsOn = await harness.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM project_members pm
      JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ${project.id} AND u.kind = 'agent'
    `);
    expect(Number(agentsOn[0]?.n)).toBe(0);
  });

  // cm:guard the constraint refuses, and the CALLER is told which field to change. Walked live on forge-beta at 74c3e4ec and it answered a bare 500 `INTERNAL_ERROR`: the index did its job and the person on the other end learned nothing, on the one route whose whole input is the handle. Before the column two agents of one name both succeeded, so the 500 is new with this change and is this change's to answer for.
  it('names the handle and the org when it refuses, rather than answering 500', async () => {
    await accounts.createAgentAccount({ orgId: orgA, projectId: projectA, handle: 'forge-dev' });
    const res = await app.request(`/api/orgs/${orgA}/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await (await import('../../src/auth/jwt.js')).signUserToken(ownerId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ handle: 'forge-dev', projectId: projectA }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('AGENT_HANDLE_TAKEN');
    expect(body.message).toContain('forge-dev');
    expect(body.message).toContain(orgA);
    expect(await accounts.listAgentAccounts(orgA)).toHaveLength(1);

    // cm:guard counted in `users`, NOT through `listAgentAccounts`: that list joins `organization_members`, so an agent whose user row committed and whose membership did not is invisible to it and this case would pass green over exactly the partial state the refusal exists to rule out. The transaction is what makes that impossible, and this is the assertion that watches the transaction rather than the list.
    const [{ n } = { n: 0 }] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users WHERE kind = 'agent'`,
    );
    expect(Number(n)).toBe(1);
  });

  // cm:guard the other direction, and it is why the unique index is on `(org_id, handle)` rather than on `handle`: two organizations each holding a `@forge-dev` is the case the synthesized address's random suffix exists to make possible under `users.email`'s system-wide unique index.
  it('admits the same name in a different org', async () => {
    await accounts.createAgentAccount({ orgId: orgA, projectId: projectA, handle: 'forge-dev' });
    await accounts.createAgentAccount({ orgId: orgB, projectId: projectB, handle: 'forge-dev' });
    expect((await accounts.listAgentAccounts(orgA))[0]?.handle).toBe('forge-dev');
    expect((await accounts.listAgentAccounts(orgB))[0]?.handle).toBe('forge-dev');
  });
});

// cm:guard the guard under test is READ OUT OF THE SHIPPED MIGRATION rather than restated here. A copy of the SQL in this file would go on passing after somebody edited the migration, which is the one failure a test of a migration exists to prevent.
describe('the migration that names existing agents', () => {
  const MIGRATION = '../../drizzle/migrations/0242_agent_handle_and_display_name.sql';

  // cm:guard slice from `DO $$` rather than testing `startsWith`: every statement in that file is preceded by the comment that prices it, so a `startsWith` filter matches nothing and the suite reports "no guards" as a passing zero rather than as a broken reader. The count assertion below is what makes that failure loud either way.
  function guardBlocks(): string[] {
    const text = readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
    return text
      .split('--> statement-breakpoint')
      .map((chunk) =>
        chunk.indexOf('DO $$') >= 0 ? chunk.slice(chunk.indexOf('DO $$')).trim() : '',
      )
      .filter((chunk) => chunk.length > 0);
  }

  // cm:guard read the message off the DRIVER's error and not off drizzle's wrapper: the wrapper's own `message` is "Failed query: DO $$…", so an assertion against it passes for a block that raised nothing of what it was supposed to say and fails for one that said it perfectly.
  function raised(e: unknown): string {
    const cause = (e as { cause?: { message?: string } }).cause;
    return cause?.message ?? (e as { message?: string }).message ?? '';
  }

  async function plantAgent(orgId: string, email: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO users (id, email, kind, email_verified_at)
      VALUES (${id}, ${email}, 'agent', now())
    `);
    await createTestOrgMember(harness.db, { orgId, userId: id, role: 'member' });
    return id;
  }

  it('reads two guard blocks out of the shipped file', () => {
    expect(guardBlocks()).toHaveLength(2);
  });

  it('aborts naming BOTH rows when two agents in one org derive the same handle', async () => {
    const first = await plantAgent(orgA, 'forge-dev.aaaaaaaaaaaa@agents.forge.invalid');
    const second = await plantAgent(orgA, 'forge-dev.bbbbbbbbbbbb@agents.forge.invalid');
    const collision = guardBlocks()[1] as string;

    const refusal = await harness.db
      .execute(sql.raw(collision))
      .then(() => null)
      .catch(raised);
    expect(refusal).toContain('forge-dev');
    // cm:guard BOTH ids, because the operator's next act is deciding which of the two keeps the name and a message naming one of them does not say what the other is.
    expect(refusal).toContain(first);
    expect(refusal).toContain(second);
  });

  it('lets the same derived handle through in two different orgs', async () => {
    await plantAgent(orgA, 'forge-dev.aaaaaaaaaaaa@agents.forge.invalid');
    await plantAgent(orgB, 'forge-dev.bbbbbbbbbbbb@agents.forge.invalid');
    await expect(harness.db.execute(sql.raw(guardBlocks()[1] as string))).resolves.toBeDefined();
  });

  it('aborts naming the row whose address yields no legal handle, rather than renaming it', async () => {
    const bad = await plantAgent(orgA, 'Forge Dev.cccccccccccc@agents.forge.invalid');
    const refusal = await harness.db
      .execute(sql.raw(guardBlocks()[0] as string))
      .then(() => null)
      .catch(raised);
    expect(refusal).toContain(bad);
    expect(refusal).toContain('not being renamed');
  });
});

describe('a credential for an agent that already exists', () => {
  /** An agent minted the way a conversation mints one: a name in a room, and no token. */
  async function tokenlessAgent(handle: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO users (id, email, kind, email_verified_at, display_name)
      VALUES (${id}, ${`${handle}.${randomUUID().slice(0, 12)}@agents.forge.invalid`}, 'agent', now(), ${handle})
    `);
    await createTestOrgMember(harness.db, { orgId: orgA, userId: id, role: 'member' });
    await harness.db.execute(
      sql`UPDATE organization_members SET handle = ${handle} WHERE user_id = ${id}`,
    );
    await harness.db.execute(
      sql`INSERT INTO project_members (user_id, project_id, role) VALUES (${id}, ${projectA}, 'member')`,
    );
    return id;
  }

  it('reports a tokenless agent as unable to act', async () => {
    await tokenlessAgent('room-handle');
    const [listed] = await accounts.listAgentAccounts(orgA);
    expect(listed?.canAct).toBe(false);
    expect(listed?.activeTokens).toBe(0);
  });

  // cm:guard the plaintext is verified through `verifyPat`, not merely returned: a route that answered 201 with a string the door then rejects is the shape this whole issue is about, and a test asserting only that a string came back cannot tell the two apart.
  it('mints one that the door actually accepts, bound to the agent’s project', async () => {
    const agentId = await tokenlessAgent('room-handle');
    const minted = await accounts.mintAgentCredential(orgA, agentId);
    expect(minted?.boundProjectId).toBe(projectA);

    const verified = await pat.verifyPat(minted?.plaintext);
    expect(verified?.row.userId).toBe(agentId);
    expect(verified?.ownerKind).toBe('agent');
    expect((await accounts.listAgentAccounts(orgA))[0]?.canAct).toBe(true);
  });

  // cm:guard re-crediting the SAME agent is the ordinary case, not an edge one: revoke-then-mint is what the two routes are for, and a revoked token keeps its name under `pat_user_name_uniq`. Name the second mint `agent:<handle>` again and this is a 500 on the second click. Measured here before the fix landed.
  it('credentials the same agent again after a revoke, under a name of its own', async () => {
    const agentId = await tokenlessAgent('room-handle');
    const first = await accounts.mintAgentCredential(orgA, agentId);
    await accounts.revokeAgentCredentials(orgA, agentId);
    const second = await accounts.mintAgentCredential(orgA, agentId);

    expect(await pat.verifyPat(first?.plaintext)).toBeNull();
    expect((await pat.verifyPat(second?.plaintext))?.row.userId).toBe(agentId);
    expect((await accounts.listAgentAccounts(orgA))[0]?.canAct).toBe(true);
  });

  // cm:guard `canAct` is BOTH halves — a live credential and a project for it to act on — and this is the row that separates them. The token is fenced to one project and `effectiveProjectRole` answers on the other side, so an agent whose project membership is removed after minting holds a credential that opens nothing. Reported as the credential fact alone, the console tells an admin to mint another one that will not help either, and the screen's own "belongs to no project" remedy is unreachable code. Found by review, F4. Make `canAct` `activeTokens > 0` again and this goes red.
  it('reports an agent with a live credential and no project as unable to act', async () => {
    const agentId = await tokenlessAgent('room-handle');
    await accounts.mintAgentCredential(orgA, agentId);
    await harness.db.execute(sql`DELETE FROM project_members WHERE user_id = ${agentId}`);

    const [listed] = await accounts.listAgentAccounts(orgA);
    expect(listed?.activeTokens).toBe(1);
    expect(listed?.projectId).toBe('');
    expect(listed?.canAct).toBe(false);
  });

  it('answers null for an id that is no agent of this org, and mints nothing', async () => {
    const stranger = await createTestUser(harness.db);
    expect(await accounts.mintAgentCredential(orgA, stranger.id)).toBeNull();
    const [{ n } = { n: 0 }] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM personal_access_tokens`,
    );
    expect(Number(n)).toBe(0);
  });

  it('refuses to mint for an agent that is a member of no project', async () => {
    const agentId = await tokenlessAgent('room-handle');
    await harness.db.execute(sql`DELETE FROM project_members WHERE user_id = ${agentId}`);
    await expect(accounts.mintAgentCredential(orgA, agentId)).rejects.toMatchObject({
      status: 400,
    });
  });

  // cm:guard `canAct` is unrevoked AND unexpired, and the expired case is the one the old `revoked_at IS NULL` count got wrong: `verifyPat` turns the token away while the console said the agent could act. Drop the expiry half of `patIsLive` and this is what goes red.
  it('reports an agent holding only an EXPIRED credential as unable to act', async () => {
    const agentId = await tokenlessAgent('room-handle');
    const minted = await accounts.mintAgentCredential(orgA, agentId);
    await harness.db.execute(
      sql`UPDATE personal_access_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = ${agentId}`,
    );
    expect(await pat.verifyPat(minted?.plaintext)).toBeNull();
    expect((await accounts.listAgentAccounts(orgA))[0]?.canAct).toBe(false);
  });

  it('takes every live credential away without retiring the account', async () => {
    const agentId = await tokenlessAgent('room-handle');
    await accounts.mintAgentCredential(orgA, agentId);
    expect(await accounts.revokeAgentCredentials(orgA, agentId)).toBe(1);

    const [listed] = await accounts.listAgentAccounts(orgA);
    expect(listed?.canAct).toBe(false);
    // cm:guard the account is still THERE, with its memberships: this verb removes what the agent may act with, and `revokeAgentAccount` is the one that removes what it may act on. Collapse the two and an admin who meant "stop it for now" has retired the handle out of every room.
    expect(listed?.userId).toBe(agentId);
    expect(listed?.projectId).toBe(projectA);
  });

  it('sets a display name a person reads, and leaves the handle alone', async () => {
    const agentId = await tokenlessAgent('room-handle');
    expect(await accounts.setAgentDisplayName(orgA, agentId, 'Trợ lý Forge')).toBe('Trợ lý Forge');
    const [listed] = await accounts.listAgentAccounts(orgA);
    expect(listed?.displayName).toBe('Trợ lý Forge');
    expect(listed?.handle).toBe('room-handle');
  });

  it('answers undefined for an id that is no agent of this org', async () => {
    const stranger = await createTestUser(harness.db);
    expect(await accounts.setAgentDisplayName(orgA, stranger.id, 'x')).toBeUndefined();
  });
});

describe('a name a person reads, over HTTP', () => {
  async function session(): Promise<string> {
    const { signUserToken } = await import('../../src/auth/jwt.js');
    return signUserToken(ownerId);
  }

  function patch(path: string, jwt: string, body: unknown) {
    return app.request(path, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('lets a person set and read back their own display name', async () => {
    const jwt = await session();
    const set = await patch('/api/auth/me', jwt, { displayName: 'Nguyễn Văn A' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { displayName: string }).displayName).toBe('Nguyễn Văn A');

    const read = await app.request('/api/auth/me', { headers: { authorization: `Bearer ${jwt}` } });
    expect(((await read.json()) as { displayName: string }).displayName).toBe('Nguyễn Văn A');
  });

  // cm:guard the member list returns the label AND the address as separate fields, because a service that folded them into one "name" would make that choice for every screen at once — and a mention picker showing a re-assignable label is the exact defect the two columns exist to keep apart (ISS-1003 criterion 10).
  it('returns the label beside the address on the org member list, null until one is typed', async () => {
    const jwt = await session();
    const before = await app.request(`/api/orgs/${orgA}/members`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const [mine] = (await before.json()) as { displayName: string | null; handle: string | null }[];
    expect(mine?.displayName).toBeNull();
    expect(mine?.handle).toBeNull();

    await patch('/api/auth/me', jwt, { displayName: 'Nguyễn Văn A' });
    const after = await app.request(`/api/orgs/${orgA}/members`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(((await after.json()) as { displayName: string }[])[0]?.displayName).toBe(
      'Nguyễn Văn A',
    );
  });

  it('carries an agent’s handle and label on the same list', async () => {
    const jwt = await session();
    const { agent } = await accounts.createAgentAccount({
      orgId: orgA,
      projectId: projectA,
      handle: 'forge-dev',
    });
    await patch(`/api/orgs/${orgA}/agents/${agent.userId}`, jwt, { displayName: 'Trợ lý Forge' });

    const res = await app.request(`/api/orgs/${orgA}/members`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const rows = (await res.json()) as { userId: string; displayName: string; handle: string }[];
    const listed = rows.find((r) => r.userId === agent.userId);
    expect(listed?.handle).toBe('forge-dev');
    expect(listed?.displayName).toBe('Trợ lý Forge');
  });

  it('mints a credential for an existing agent over HTTP, once', async () => {
    const jwt = await session();
    const { agent } = await accounts.createAgentAccount({
      orgId: orgA,
      projectId: projectA,
      handle: 'forge-dev',
    });
    await accounts.revokeAgentCredentials(orgA, agent.userId);

    const res = await app.request(`/api/orgs/${orgA}/agents/${agent.userId}/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(201);
    const { plaintext } = (await res.json()) as { plaintext: string };
    expect((await pat.verifyPat(plaintext))?.row.userId).toBe(agent.userId);

    // cm:guard no later read hands the plaintext back — the row stores a hash and there is nothing to return. A list that carried it would turn one leak of a response body into every token.
    const list = await app.request(`/api/orgs/${orgA}/agents`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(JSON.stringify(await list.json())).not.toContain(plaintext);
  });

  it('refuses every one of these to a member who is not an org admin', async () => {
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const outsider = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${outsider.id}`,
    );
    await createTestOrgMember(harness.db, { orgId: orgA, userId: outsider.id, role: 'member' });
    const jwt = await signUserToken(outsider.id);
    const { agent } = await accounts.createAgentAccount({
      orgId: orgA,
      projectId: projectA,
      handle: 'forge-dev',
    });

    for (const [method, path] of [
      ['GET', `/api/orgs/${orgA}/agents`],
      ['POST', `/api/orgs/${orgA}/agents/${agent.userId}/tokens`],
      ['DELETE', `/api/orgs/${orgA}/agents/${agent.userId}/tokens`],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect([403, 404]).toContain(res.status);
    }
    expect((await accounts.listAgentAccounts(orgA))[0]?.activeTokens).toBe(1);
  });
});
