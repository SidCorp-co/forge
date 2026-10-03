/**
 * An issue update records the changes it made, through both doors that write fields: REST `PATCH`
 * and MCP `forge_issues update`. A lease renewal records the one key it moved, never the whole
 * `sessionContext`; a write that moves nothing records nothing; and the activity route hands the
 * change shape back as it is stored.
 */

import { randomUUID } from 'node:crypto';
import type { IssueUpdatedPayload } from '@forge/contracts/field-changes';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
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
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ mintPat } = await import('../../src/auth/pat.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let personId: string;
let projectId: string;
let jwt: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const person = await createTestUser(harness.db);
  personId = person.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${personId}`);
  projectId = (await createTestProject(harness.db, personId)).id;
  await createTestProjectMember(harness.db, { userId: personId, projectId, role: 'admin' });
  jwt = await signUserToken(personId);
});

async function rest(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status >= 300)
    throw new Error(`${method} ${path} answered ${res.status}: ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
}

async function newIssue(): Promise<string> {
  const created = await rest('POST', `/api/projects/${projectId}/issues`, {
    title: 'subject',
    priority: 'low',
    status: 'draft',
  });
  return created.id as string;
}

async function updates(issueId: string): Promise<IssueUpdatedPayload[]> {
  const rows = (await harness.db.execute(sql`
    SELECT payload FROM activity_log WHERE issue_id = ${issueId} AND action = 'issue.updated'
    ORDER BY created_at, id`)) as unknown as Array<{ payload: IssueUpdatedPayload }>;
  return rows.map((r) => r.payload);
}

const worklog = { head: '9d2e6d1', notes: 'w'.repeat(6000) };
const context = (renewedAt: string, history: unknown[]) => ({
  lease: { holder: 'iss-1-abc', renewedAt, history },
  worklog,
});

describe('REST PATCH records the changes it made', () => {
  it('a lease renewal records the key it moved, not the context', async () => {
    const id = await newIssue();
    await rest('PATCH', `/api/issues/${id}`, { sessionContext: context('t1', [{ how: 'claim' }]) });
    await rest('PATCH', `/api/issues/${id}`, {
      sessionContext: context('t2', [{ how: 'claim' }, { how: 'write' }]),
    });

    const [, renewal] = await updates(id);
    expect(renewal).toEqual({
      fields: ['sessionContext'],
      changes: [
        { path: ['sessionContext', 'lease', 'history', 1], op: 'add', after: { how: 'write' } },
        { path: ['sessionContext', 'lease', 'renewedAt'], op: 'set', before: 't1', after: 't2' },
      ],
    });
    expect(JSON.stringify(renewal).length).toBeLessThan(400);
  });

  it('records only the fields whose value moved', async () => {
    const id = await newIssue();
    await rest('PATCH', `/api/issues/${id}`, { title: 'renamed', priority: 'low' });

    expect(await updates(id)).toEqual([
      {
        fields: ['title'],
        changes: [{ path: ['title'], op: 'set', before: 'subject', after: 'renamed' }],
      },
    ]);
  });

  it('records nothing for a write that changes nothing, a re-sent context included', async () => {
    const id = await newIssue();
    const doc = context('t1', [{ how: 'claim' }]);
    await rest('PATCH', `/api/issues/${id}`, { sessionContext: doc });
    const before = (await updates(id)).length;

    await rest('PATCH', `/api/issues/${id}`, {
      sessionContext: structuredClone(doc),
      title: 'subject',
    });

    expect((await updates(id)).length).toBe(before);
  });

  it('the activity route hands back the change shape as stored', async () => {
    const id = await newIssue();
    await rest('PATCH', `/api/issues/${id}`, { title: 'renamed' });

    const feed = await rest('GET', `/api/issues/${id}/activity`);
    const row = (feed.items as Array<{ action: string; payload: unknown }>).find(
      (i) => i.action === 'issue.updated',
    );
    expect(row?.payload).toEqual({
      fields: ['title'],
      changes: [{ path: ['title'], op: 'set', before: 'subject', after: 'renamed' }],
    });
  });
});

describe('MCP forge_issues update records the changes it made', () => {
  it('an MCP field write records its changes as a REST one does, and a no-op records nothing', async () => {
    const id = await newIssue();
    const { plaintext } = await mintPat({ userId: personId, name: `mcp-${randomUUID()}` });
    const mcp = await connectClientAsPat(plaintext);
    try {
      const update = async (data: Record<string, unknown>) =>
        parseToolResult(
          (await mcp.client.callTool({
            name: 'forge_issues',
            arguments: { action: 'update', documentId: id, data },
          })) as { content: Array<{ type: string; text: string }> },
        );
      await update({ title: 'renamed over mcp' });
      await update({ title: 'renamed over mcp' });
    } finally {
      await mcp.close();
    }

    expect(await updates(id)).toEqual([
      {
        fields: ['title'],
        changes: [{ path: ['title'], op: 'set', before: 'subject', after: 'renamed over mcp' }],
      },
    ]);
  });
});
