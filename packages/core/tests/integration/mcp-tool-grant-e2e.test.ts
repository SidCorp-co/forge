import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectId: string;
let issueId: string;
let tokens: Record<'issuesRead' | 'knowledgeRead' | 'statedFull' | 'legacy' | 'turn', string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_PAT_READ_MAX = '100000';
  process.env.RATE_LIMIT_PAT_WRITE_MAX = '100000';

  await truncateAll(harness.db);
  const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  const org = await seedOrg(harness.db, user.id);
  projectId = (await createTestProject(harness.db, user.id, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { projectId, userId: user.id, role: 'admin' });
  issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 9000, 'grant probe', 'open', ${user.id})
  `);

  const { mintPat } = await import('../../src/auth/pat.js');
  const mint = async (name: string, permissions: string[] | undefined) =>
    (await mintPat({ userId: user.id, name, ...(permissions ? { permissions } : {}) })).plaintext;
  const legacy = await mintPat({ userId: user.id, name: 'legacy' });
  await harness.db.execute(
    sql`UPDATE personal_access_tokens SET permissions = NULL WHERE id = ${legacy.row.id}`,
  );
  const { AGENT_TURN_MENU, mintTurnCredential, resolveTurnAuthority } = await import(
    '../../src/auth/turn-credential.js'
  );
  const authority = await resolveTurnAuthority({ userId: user.id, projectId, viaTokenId: null });
  if (!authority.ok) throw new Error(authority.refusal.message);
  const turn = await mintTurnCredential({
    authority: authority.authority,
    menu: AGENT_TURN_MENU,
    name: `turn:${randomUUID()}`,
    ttlMs: 60_000,
  });
  tokens = {
    issuesRead: await mint('issues-read', ['issues:read']),
    knowledgeRead: await mint('knowledge-read', ['knowledge:read']),
    statedFull: await mint('stated-full', ['*']),
    legacy: legacy.plaintext,
    turn: turn.token,
  };

  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
  ({ app } = await import('../../src/index.js'));
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
});

async function call(bearer: string, name: string, args: Record<string, unknown>) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return {
    isError: out.result.isError ?? false,
    text: out.result.content.map((c) => c.text).join('\n'),
  };
}

const create = (title: string) => ({
  action: 'create',
  projectId,
  data: { title, category: 'chore' },
});

async function issueTitled(title: string): Promise<boolean> {
  const rows = await harness.db.execute(sql`SELECT 1 FROM issues WHERE title = ${title}`);
  return rows.length > 0;
}

describe('an MCP tool call fenced by the token grant', () => {
  it('refuses an issue write to a token granted issues:read, by name, and writes nothing', async () => {
    const out = await call(tokens.issuesRead, 'forge_issues', create('read-only wrote this'));
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(
      /FORBIDDEN: forge_issues action 'create' needs 'issues:write', and this token was not granted it \(it holds: issues:read\)/,
    );
    expect(await issueTitled('read-only wrote this')).toBe(false);
  });

  it('passes a read action on that read grant', async () => {
    const out = await call(tokens.issuesRead, 'forge_issues', {
      action: 'get',
      documentId: issueId,
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.text).toContain('grant probe');
  });

  it('refuses a token whose grant names another resource', async () => {
    const out = await call(tokens.knowledgeRead, 'forge_issues', {
      action: 'get',
      documentId: issueId,
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/needs 'issues:read'.*it holds: knowledge:read/);
  });

  it('refuses a call naming no action on a per-action tool, whatever the grant', async () => {
    const out = await call(tokens.statedFull, 'forge_issues', { projectId });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/forge_issues a call naming no action declares no grant/);
  });

  for (const which of ['statedFull', 'legacy', 'turn'] as const) {
    it(`lets a ${which} token write, so whole reach is not narrowed`, async () => {
      const title = `${which} wrote this`;
      const out = await call(tokens[which], 'forge_issues', create(title));
      expect(out.isError, out.text).toBe(false);
      expect(await issueTitled(title)).toBe(true);
    });
  }

  it('lets a turn token read a project-reach resource beyond the tracker', async () => {
    const out = await call(tokens.turn, 'forge_schedules', { action: 'list', projectId });
    expect(out.isError, out.text).toBe(false);
  });

  it('runs a tool declared ungranted on any grant', async () => {
    const out = await call(tokens.knowledgeRead, 'forge_health', {});
    expect(out.isError, out.text).toBe(false);
  });
});
