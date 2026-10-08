/**
 * ISS-1374 — an issue records the credential it was created through.
 *
 * Every create here goes through `app.request` (or the loopback MCP client) with a real credential,
 * because what is under test is what a DOOR establishes: a test that hands `createIssue` a writer
 * proves the writer. Before this change every REST create read `web`, a session and a token alike.
 *
 * Postgres is real because the CHECK, the foreign key and its ON DELETE SET NULL are things the
 * DATABASE does, and the search filters are SQL.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let accounts: typeof import('../../src/orgs/agent-accounts.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ mintPat } = await import('../../src/auth/pat.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  accounts = await import('../../src/orgs/agent-accounts.js');
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let orgId: string;
let personId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${personId}`);
  const project = await createTestProject(harness.db, personId);
  projectId = project.id;
  orgId = project.orgId;
  await harness.db.execute(
    sql`UPDATE organization_members SET role = 'admin' WHERE org_id = ${orgId} AND user_id = ${personId}`,
  );
  await createTestProjectMember(harness.db, { userId: personId, projectId, role: 'admin' });
});

type Row = { id: string; createdVia: string | null; createdViaTokenId: string | null };

async function create(token: string, title: string): Promise<Row> {
  const res = await app.request(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, priority: 'low', status: 'draft' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Row;
}

async function storedRow(id: string): Promise<{ via: string | null; token: string | null }> {
  const rows = (await harness.db.execute(
    sql`SELECT created_via AS via, created_via_token_id AS token FROM issues WHERE id = ${id}`,
  )) as unknown as Array<{ via: string | null; token: string | null }>;
  const row = rows[0];
  if (!row) throw new Error(`issue ${id} is not stored`);
  return row;
}

async function personPat(): Promise<{ plaintext: string; tokenId: string }> {
  const { plaintext, row } = await mintPat({ userId: personId, name: `box-${randomUUID()}` });
  return { plaintext, tokenId: row.id };
}

async function deviceBoundPat(): Promise<{ plaintext: string; tokenId: string }> {
  const device = await createTestDevice(harness.db, personId);
  const { plaintext, row } = await mintPat({
    userId: personId,
    name: `device-${randomUUID()}`,
    deviceId: device.id,
  });
  return { plaintext, tokenId: row.id };
}

async function searchIds(token: string, query: string): Promise<{ status: number; ids: string[] }> {
  const res = await app.request(`/api/projects/${projectId}/issues/search?${query}&limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items?: Array<{ id: string }> };
  return { status: res.status, ids: (body.items ?? []).map((i) => i.id) };
}

describe('a REST create records the credential it came through', () => {
  // Criterion 1
  it('a session JWT reads web and names no token', async () => {
    const made = await create(await signUserToken(personId), 'typed in a browser');
    expect(made.createdVia).toBe('web');
    expect(made.createdViaTokenId).toBeNull();
    expect(await storedRow(made.id)).toEqual({ via: 'web', token: null });
  });

  // Criterion 2 — the reproduction.
  it('a personal access token reads pat and names that token', async () => {
    const pat = await personPat();
    const made = await create(pat.plaintext, 'filed from a terminal');
    expect(made.createdVia).toBe('pat');
    expect(made.createdViaTokenId).toBe(pat.tokenId);
    expect(await storedRow(made.id)).toEqual({ via: 'pat', token: pat.tokenId });
  });

  it('two tokens of one owner are told apart by the id each created with', async () => {
    const one = await personPat();
    const two = await personPat();
    const madeOne = await create(one.plaintext, 'by the first key');
    const madeTwo = await create(two.plaintext, 'by the second key');
    expect(madeOne.createdViaTokenId).toBe(one.tokenId);
    expect(madeTwo.createdViaTokenId).toBe(two.tokenId);
    expect(one.tokenId).not.toBe(two.tokenId);
  });

  // Criterion 3
  it("a token bound to a paired device reads device and names that device's token", async () => {
    const pat = await deviceBoundPat();
    const made = await create(pat.plaintext, 'filed from a paired box');
    expect(made.createdVia).toBe('device');
    expect(made.createdViaTokenId).toBe(pat.tokenId);
    expect(await storedRow(made.id)).toEqual({ via: 'device', token: pat.tokenId });
  });

  // Criterion 12 — the agency rule is the owner's kind, beside the credential and untouched by it.
  it('a token held by an agent account reads pat and the creator is still an agent', async () => {
    const created = await accounts.createAgentAccount({
      orgId,
      projectIds: [projectId],
      handle: `master-${randomUUID().slice(0, 8)}`,
    });
    const made = await create(created.plaintext, 'filed by a named agent');
    expect(made.createdVia).toBe('pat');
    expect(made.createdViaTokenId).not.toBeNull();

    const listed = await app.request(`/api/projects/${projectId}/issues?limit=100`, {
      headers: { authorization: `Bearer ${(await personPat()).plaintext}` },
    });
    const row = (
      (await listed.json()) as { items: Array<{ id: string; creatorIsAgent: boolean }> }
    ).items.find((r) => r.id === made.id);
    expect(row?.creatorIsAgent).toBe(true);
  });
});

describe('the reads expose the credential', () => {
  // Criterion 6 — all three shapes that emit an issue.
  it('detail, list and search each carry createdVia and createdViaTokenId', async () => {
    const pat = await personPat();
    const made = await create(pat.plaintext, 'read three ways');
    const headers = { authorization: `Bearer ${pat.plaintext}` };

    const detail = (await (await app.request(`/api/issues/${made.id}`, { headers })).json()) as Row;
    expect([detail.createdVia, detail.createdViaTokenId]).toEqual(['pat', pat.tokenId]);

    const list = (await (
      await app.request(`/api/projects/${projectId}/issues?limit=100`, { headers })
    ).json()) as { items: Row[] };
    const listed = list.items.find((r) => r.id === made.id);
    expect([listed?.createdVia, listed?.createdViaTokenId]).toEqual(['pat', pat.tokenId]);

    const search = (await (
      await app.request(`/api/projects/${projectId}/issues/search?limit=100`, { headers })
    ).json()) as { items: Row[] };
    const found = search.items.find((r) => r.id === made.id);
    expect([found?.createdVia, found?.createdViaTokenId]).toEqual(['pat', pat.tokenId]);
  });

  // Criterion 7 — both halves: the filter must exclude as well as include.
  it('the search filters return exactly the issues of that channel and that token', async () => {
    const one = await personPat();
    const two = await personPat();
    const jwt = await signUserToken(personId);
    const byOne = await create(one.plaintext, 'by one');
    const byTwo = await create(two.plaintext, 'by two');
    const byJwt = await create(jwt, 'by a session');

    expect((await searchIds(jwt, `createdViaToken=${one.tokenId}`)).ids).toEqual([byOne.id]);
    expect((await searchIds(jwt, `createdViaToken=${two.tokenId}`)).ids).toEqual([byTwo.id]);
    expect((await searchIds(jwt, 'createdVia=web')).ids).toEqual([byJwt.id]);
    expect((await searchIds(jwt, 'createdVia=pat')).ids.sort()).toEqual(
      [byOne.id, byTwo.id].sort(),
    );
  });

  it('a channel outside the set, and a token that is not a uuid, are refused by the search', async () => {
    const jwt = await signUserToken(personId);
    expect((await searchIds(jwt, 'createdVia=carrier-pigeon')).status).toBe(400);
    expect((await searchIds(jwt, 'createdViaToken=not-a-uuid')).status).toBe(400);
  });
});

describe('the MCP door records the token behind it', () => {
  // Criterion 8
  it('a forge_issues create reads mcp with the calling token, and get and list return both', async () => {
    const pat = await personPat();
    const ctx = await connectClientAsPat(pat.plaintext);
    try {
      const created = parseToolResult(
        (await ctx.client.callTool({
          name: 'forge_issues',
          arguments: {
            action: 'create',
            projectId,
            data: { title: 'filed over MCP', priority: 'low', status: 'draft' },
          },
        })) as never,
      ) as { documentId: string; createdVia: string; createdViaTokenId: string };
      expect(created.createdVia).toBe('mcp');
      expect(created.createdViaTokenId).toBe(pat.tokenId);
      expect(await storedRow(created.documentId)).toEqual({ via: 'mcp', token: pat.tokenId });

      const got = parseToolResult(
        (await ctx.client.callTool({
          name: 'forge_issues',
          arguments: { action: 'get', documentId: created.documentId },
        })) as never,
      ) as { createdVia: string; createdViaTokenId: string };
      expect([got.createdVia, got.createdViaTokenId]).toEqual(['mcp', pat.tokenId]);

      const listed = parseToolResult(
        (await ctx.client.callTool({
          name: 'forge_issues',
          arguments: { action: 'list', projectId },
        })) as never,
      ) as { issues: Array<{ documentId: string; createdVia: string; createdViaTokenId: string }> };
      const row = listed.issues.find((i) => i.documentId === created.documentId);
      expect([row?.createdVia, row?.createdViaTokenId]).toEqual(['mcp', pat.tokenId]);
    } finally {
      await ctx.close();
    }
  });
});

/** Everything one failed statement says, driver wrapper and cause together. */
async function failureTextOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '';
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  }
}

describe('the database holds the shape itself', () => {
  async function insertIssue(via: string | null, token: string | null): Promise<unknown> {
    return harness.db.execute(sql`
      INSERT INTO issues (project_id, title, created_by_id, created_via, created_via_token_id)
      VALUES (${projectId}, 'direct', ${personId}, ${via}, ${token})
    `);
  }

  // Criterion 10
  it('refuses a channel outside the set, naming the constraint', async () => {
    expect(await failureTextOf(insertIssue('carrier-pigeon', null))).toContain(
      'issues_created_via_chk',
    );
  });

  it('refuses a token id that names no token, naming the foreign key', async () => {
    expect(await failureTextOf(insertIssue('pat', randomUUID()))).toContain(
      'issues_created_via_token_id_personal_access_tokens_id_fk',
    );
  });

  it.each(['web', 'mcp', 'pipeline', 'schedule', 'system', 'pat', 'device'])(
    'accepts the channel %s',
    async (via) => {
      await insertIssue(via, null);
    },
  );

  it('refuses a token id on a channel no token can come through, naming the constraint', async () => {
    const pat = await personPat();
    expect(await failureTextOf(insertIssue('web', pat.tokenId))).toContain(
      'issues_created_via_token_chk',
    );
    expect(await failureTextOf(insertIssue('system', pat.tokenId))).toContain(
      'issues_created_via_token_chk',
    );
  });

  it.each(['pat', 'device', 'mcp'])('accepts a token id on the %s channel', async (via) => {
    await insertIssue(via, (await personPat()).tokenId);
  });

  it('accepts a token channel with no token id, which is what a deleted token leaves', async () => {
    await insertIssue('pat', null);
  });

  // Criterion 11
  it('a deleted token leaves its issues with a NULL token id and the same channel', async () => {
    const pat = await personPat();
    const made = await create(pat.plaintext, 'its token is about to go');
    await harness.db.execute(sql`DELETE FROM personal_access_tokens WHERE id = ${pat.tokenId}`);
    expect(await storedRow(made.id)).toEqual({ via: 'pat', token: null });
  });
});
