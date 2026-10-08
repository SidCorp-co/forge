/**
 * ISS-1225 — an edge says how long it holds, at every door that writes or reads one.
 *
 * The admissible route's own cases live beside the blocks clause in `admissible-blocked-e2e`. What
 * is here is the other half of the proposition: `holdsUntil` is accepted, refused by name and read
 * back the same way at REST, `forge_project_pm set_dependency` and `forge_issues data.relations`,
 * and a refused write leaves no edge behind. Real Postgres, because the table's own CHECK is the
 * last of the refusals and a mock cannot answer it.
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

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let userId: string;
let token: string;
let pat: string;

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
  const user = await createTestUser(harness.db);
  userId = user.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (await createTestProject(harness.db, userId)).id;
  await createTestProjectMember(harness.db, { userId, projectId, role: 'admin' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  token = await signUserToken(userId);
  pat = (await mintPat({ userId, name: 'admin', scopes: ['read', 'write', 'admin'] })).plaintext;
});

async function issue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${userId})`);
  return id;
}

type EdgeRow = { kind: string; holds_until: string };

async function edgeRows(): Promise<EdgeRow[]> {
  return (await harness.db.execute(
    sql`SELECT kind, holds_until FROM issue_dependencies WHERE project_id = ${projectId} ORDER BY created_at`,
  )) as unknown as EdgeRow[];
}

async function rest(path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function mcp(name: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    if (res.isError) return { error: res.content[0]?.text ?? '' };
    return { value: parseToolResult(res) as Record<string, unknown> };
  } finally {
    await ctx.close();
  }
}

/** One write per door, each handed the same two issues and the same edge declaration. */
type Door = (
  from: string,
  to: string,
  edge: Record<string, unknown>,
) => Promise<{ refused?: string }>;

const doors: Record<string, Door> = {
  'REST POST /api/issues/:id/dependencies': async (from, to, edge) => {
    const r = await rest(`/api/issues/${to}/dependencies`, { dependsOnId: from, ...edge });
    return r.status < 300 ? {} : { refused: JSON.stringify(r.body) };
  },
  'forge_project_pm set_dependency': async (from, to, edge) => {
    const r = await mcp('forge_project_pm', {
      action: 'set_dependency',
      projectId,
      fromIssueId: from,
      toIssueId: to,
      ...edge,
    });
    return r.error ? { refused: r.error } : {};
  },
  'forge_issues data.relations': async (from, to, edge) => {
    const r = await mcp('forge_issues', {
      action: 'update',
      projectId,
      documentId: to,
      data: { relations: [{ dependsOnId: from, ...edge }] },
    });
    return r.error ? { refused: r.error } : {};
  },
};

describe.each(Object.entries(doors))('%s', (_name, write) => {
  it('writes a shipped hold on a blocks edge and stores it', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    expect(await write(from, to, { kind: 'blocks', holdsUntil: 'shipped' })).toEqual({});
    expect(await edgeRows()).toEqual([{ kind: 'blocks', holds_until: 'shipped' }]);
  });

  it('stores a blocks edge that declares nothing as settled', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    expect(await write(from, to, { kind: 'blocks' })).toEqual({});
    expect(await edgeRows()).toEqual([{ kind: 'blocks', holds_until: 'settled' }]);
  });

  it('refuses a shipped hold on a relates edge by name, and writes no edge', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    const { refused } = await write(from, to, { kind: 'relates', holdsUntil: 'shipped' });
    expect(refused).toContain('HOLD_NEEDS_BLOCKS');
    expect(await edgeRows()).toEqual([]);
  });

  it('refuses a hold that is neither settled nor shipped, naming the field, and writes no edge', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    const { refused } = await write(from, to, { kind: 'blocks', holdsUntil: 'whenever' });
    expect(refused).toContain('holdsUntil');
    expect(await edgeRows()).toEqual([]);
  });
});

describe('re-sending an edge', () => {
  async function send(from: string, to: string, holdsUntil?: 'settled' | 'shipped') {
    const { setIssueDependency } = await import('../../src/issues/dependency-service.js');
    return setIssueDependency(
      { projectId, fromIssueId: from, toIssueId: to, kind: 'blocks', holdsUntil },
      { actor: { type: 'user', id: userId, agency: 'human' }, createdById: userId },
    );
  }

  it('changes the hold when it differs, and reports it updated', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    await send(from, to);
    expect(await send(from, to, 'shipped')).toMatchObject({ created: false, updated: true });
    expect(await edgeRows()).toEqual([{ kind: 'blocks', holds_until: 'shipped' }]);
    expect(await send(from, to, 'settled')).toMatchObject({ created: false, updated: true });
    expect(await edgeRows()).toEqual([{ kind: 'blocks', holds_until: 'settled' }]);
  });

  it('reports nothing changed when the same hold is sent again', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    await send(from, to, 'shipped');
    expect(await send(from, to, 'shipped')).toMatchObject({ created: false, updated: false });
  });

  it('leaves the stored hold alone when the field is omitted', async () => {
    const [from, to] = [await issue(1), await issue(2)];
    await send(from, to, 'shipped');
    expect(await send(from, to)).toMatchObject({ created: false, updated: false });
    expect(await edgeRows()).toEqual([{ kind: 'blocks', holds_until: 'shipped' }]);
  });
});

describe('reading an edge back', () => {
  it("reports each edge's hold on REST and on forge_issues get, so a client can tell them apart", async () => {
    const [blocker, shipped, settled] = [await issue(1), await issue(2), await issue(3)];
    await rest(`/api/issues/${shipped}/dependencies`, {
      dependsOnId: blocker,
      kind: 'blocks',
      holdsUntil: 'shipped',
    });
    await rest(`/api/issues/${settled}/dependencies`, { dependsOnId: blocker, kind: 'blocks' });

    const dependencies = await rest(`/api/issues/${blocker}/dependencies`);
    const byTo = Object.fromEntries(
      (dependencies.body.outgoing as Array<{ toIssueId: string; holdsUntil: string }>).map((e) => [
        e.toIssueId,
        e.holdsUntil,
      ]),
    );
    expect(byTo).toEqual({ [shipped]: 'shipped', [settled]: 'settled' });

    const got = await mcp('forge_issues', { action: 'get', projectId, documentId: blocker });
    const relations = got.value?.relations as { blocks?: unknown[] } | undefined;
    const digest = (relations?.blocks ?? []) as Array<{
      toIssueId: string;
      holdsUntil: string;
    }>;
    expect(Object.fromEntries(digest.map((e) => [e.toIssueId, e.holdsUntil]))).toEqual({
      [shipped]: 'shipped',
      [settled]: 'settled',
    });
  });
});
