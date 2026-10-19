/**
 * ISS-1229 r17, judge-44: an archived project still took a new issue (`POST` answered 201), which no
 * sweep, list or run of an archived project would ever read. Each door that files an issue refuses it
 * by name and files nothing, and the nightly proposal files nothing there; a live project beside it
 * still takes one, so a door that refuses everything goes red too.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
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
let ownerId: string;
let jwt: string;
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
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  jwt = await signUserToken(ownerId);
  pat = (await mintPat({ userId: ownerId, name: 'owner', scopes: ['read', 'write', 'admin'] }))
    .plaintext;
});

async function project(archived: boolean): Promise<string> {
  const { id } = await createTestProject(harness.db, ownerId);
  if (archived) {
    await harness.db.execute(
      sql`UPDATE projects SET archived_at = '2026-10-18T09:00:00Z' WHERE id = ${id}`,
    );
  }
  return id;
}

async function issueCount(projectId: string): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM issues WHERE project_id = ${projectId}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function rest(projectId: string) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Export the ledger' }),
  });
  return { status: res.status, body: await res.text() };
}

async function mcp(projectId: string) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({
      name: 'forge_issues',
      arguments: { action: 'create', projectId, data: { title: 'Export the ledger' } },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    if (res.isError) return { refused: res.content[0]?.text ?? '' };
    parseToolResult(res);
    return { refused: null };
  } finally {
    await ctx.close();
  }
}

describe('an archived project takes no new issue', () => {
  it('is refused PROJECT_ARCHIVED at the REST door, naming the way out, and files nothing', async () => {
    const archived = await project(true);
    const res = await rest(archived);
    expect(res.status).toBe(409);
    expect(res.body).toContain('PROJECT_ARCHIVED');
    expect(res.body).toContain('archived on 2026-10-18, so it takes no new issues');
    expect(res.body).toContain('unarchive it first');
    expect(await issueCount(archived)).toBe(0);
  });

  it('is refused PROJECT_ARCHIVED through forge_issues create, and files nothing', async () => {
    const archived = await project(true);
    const res = await mcp(archived);
    expect(res.refused).toContain('PROJECT_ARCHIVED');
    expect(res.refused).toContain('unarchive it first');
    expect(await issueCount(archived)).toBe(0);
  });

  it('still files an issue in a live project at both doors', async () => {
    const live = await project(false);
    expect((await rest(live)).status).toBe(201);
    expect((await mcp(live)).refused).toBeNull();
    expect(await issueCount(live)).toBe(2);
  });

  it('files no nightly knowledge-promotion proposal in an archived project', async () => {
    const { proposeKnowledgePromotions } = await import('../../src/memory/knowledge-promotion.js');
    for (const archived of [true, false]) {
      const id = await project(archived);
      await harness.db.execute(sql`
        UPDATE projects
           SET agent_config = '{"pipelineConfig":{"knowledgePromotion":{"enabled":true,"minRetrievals":1}}}'::jsonb
         WHERE id = ${id}`);
      await harness.db.execute(sql`
        INSERT INTO memories (project_id, source, source_ref, text_content, retrieval_count, created_at)
        VALUES (${id}, 'decision', ${`ref-${archived}`}, 'a lesson', 9, now() - interval '30 days')`);
      await proposeKnowledgePromotions(id);
      expect(await issueCount(id), archived ? 'archived' : 'live').toBe(archived ? 0 : 1);
    }
  });
});
