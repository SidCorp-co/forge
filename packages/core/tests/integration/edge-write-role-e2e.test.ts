/**
 * ISS-1225 — one role writes an edge, whichever door it comes in by.
 *
 * An edge gates dispatch, so who may write one is kernel input and cannot differ by transport.
 * REST `POST /api/issues/:id/dependencies`, `forge_project_pm set_dependency` (and its deprecated
 * `forge_pm.set_dependency` alias) and `forge_issues data.relations` each resolve the caller's role
 * on the project and refuse a viewer. This file drives every door as a viewer, a member and an
 * admin, and the REST door under both credentials it takes (a user JWT and a PAT), so a door that
 * admits a role another refuses goes red naming itself. A refused write leaves no edge behind, and
 * the refusal names the role held and the role the write needs.
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
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

type Role = 'viewer' | 'member' | 'admin';
type Caller = { jwt: string; pat: string };

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let issueOwnerId: string;
let callers: Record<Role, Caller>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  issueOwnerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');

  const built: Partial<Record<Role, Caller>> = {};
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    await createTestProjectMember(harness.db, { userId: user.id, projectId, role });
    built[role] = {
      jwt: await signUserToken(user.id),
      pat: (await mintPat({ userId: user.id, name: role, scopes: ['read', 'write', 'admin'] }))
        .plaintext,
    };
  }
  callers = built as Record<Role, Caller>;
});

async function issue(seq: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${issueOwnerId})`);
  return id;
}

async function edgeCount(): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM issue_dependencies WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function rest(bearer: string, to: string, from: string) {
  const res = await fetch(`${server.baseUrl}/api/issues/${to}/dependencies`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dependsOnId: from, kind: 'blocks' }),
  });
  const body = await res.text();
  return res.status < 300 ? {} : { refused: body };
}

async function mcp(pat: string, name: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    if (res.isError) return { refused: res.content[0]?.text ?? '' };
    parseToolResult(res);
    return {};
  } finally {
    await ctx.close();
  }
}

type Door = (who: Caller, from: string, to: string) => Promise<{ refused?: string }>;

const doors: Record<string, Door> = {
  'REST POST /api/issues/:id/dependencies, user JWT': (who, from, to) => rest(who.jwt, to, from),
  'REST POST /api/issues/:id/dependencies, PAT': (who, from, to) => rest(who.pat, to, from),
  'forge_project_pm set_dependency': (who, from, to) =>
    mcp(who.pat, 'forge_project_pm', {
      action: 'set_dependency',
      projectId,
      fromIssueId: from,
      toIssueId: to,
      kind: 'blocks',
    }),
  'forge_pm.set_dependency (deprecated alias)': (who, from, to) =>
    mcp(who.pat, 'forge_pm.set_dependency', {
      projectId,
      fromIssueId: from,
      toIssueId: to,
      kind: 'blocks',
    }),
  'forge_issues data.relations': (who, from, to) =>
    mcp(who.pat, 'forge_issues', {
      action: 'update',
      projectId,
      documentId: to,
      data: { relations: [{ kind: 'blocks', dependsOnId: from }] },
    }),
};

describe.each(Object.entries(doors))('%s', (_name, write) => {
  it('refuses a viewer by name, naming the role held and the role the write needs, and writes no edge', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    const { refused } = await write(callers.viewer, from, to);
    expect(refused, 'a viewer must not be able to write an edge').toBeDefined();
    expect(refused).toContain('role held is viewer');
    expect(refused).toContain('requires the project member role');
    expect(await edgeCount()).toBe(0);
  });

  it.each(['member', 'admin'] as const)('admits a project %s and writes the edge', async (role) => {
    const [from, to] = [await issue(1), await issue(2)];
    expect(await write(callers[role], from, to)).toEqual({});
    expect(await edgeCount()).toBe(1);
  });
});

describe('a person who is no member at all', () => {
  it('reads as an unknown project at set_dependency, not as a role refusal', async () => {
    const stranger = await createTestUser(harness.db);
    const { mintPat } = await import('../../src/auth/pat.js');
    const pat = (await mintPat({ userId: stranger.id, name: 'stranger' })).plaintext;
    const [from, to] = [await issue(1), await issue(2)];
    const { refused } = await mcp(pat, 'forge_project_pm', {
      action: 'set_dependency',
      projectId,
      fromIssueId: from,
      toIssueId: to,
      kind: 'blocks',
    });
    expect(refused).toContain('project not found or not accessible');
    expect(await edgeCount()).toBe(0);
  });
});
