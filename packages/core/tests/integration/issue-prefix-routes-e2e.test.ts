/**
 * ISS-992 — the prefix as a person meets it: the project PATCH that sets one, and the issues API
 * that renders and resolves references under it. Its sibling `issue-prefix-e2e.test.ts` holds the
 * half below the routes — the constraints, the trigger and the service.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let assignIssuePrefix: typeof import('../../src/issues/issue-prefix-service.js').assignIssuePrefix;
let heldIssuePrefixes: typeof import('../../src/issues/issue-prefix-read.js').heldIssuePrefixes;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  // cm:guard every core import here is DYNAMIC and happens after the env above is set — `db/client.ts` binds its pool at module load, so a static import resolves the wrong database before a case runs.
  ({ assignIssuePrefix } = await import('../../src/issues/issue-prefix-service.js'));
  ({ heldIssuePrefixes } = await import('../../src/issues/issue-prefix-read.js'));
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  const { projectRoutes } = await import('../../src/projects/routes.js');
  const { issueProjectRoutes } = await import('../../src/issues/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  app = new Hono();
  app.onError(errorHandler);
  app.route('/api/projects', projectRoutes);
  app.route('/api/projects', issueProjectRoutes);
}, 300_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
});

async function project() {
  return createTestProject(harness.db, userId);
}

async function assign(projectId: string, prefix: string) {
  return assignIssuePrefix(projectId, prefix);
}

async function activePrefixOf(projectId: string): Promise<string | null> {
  const rows = (await harness.db.execute(
    sql`SELECT issue_prefix FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ issue_prefix: string | null }>;
  return rows[0]?.issue_prefix ?? null;
}

describe('the issues API under a prefix', () => {
  async function get(path: string) {
    const res = await app.request(path, {
      headers: { authorization: `Bearer ${await signUserToken(userId)}` },
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  async function issueIn(projectId: string, issSeq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, 'open', 'medium', ${userId})
    `);
    return id;
  }

  // cm:why criterion 1 — a project that has set no prefix is the case every other suite in the repo already runs under, and this is the one that says so on purpose.
  it('renders ISS-977 where the project has set no prefix', async () => {
    const a = await project();
    await issueIn(a.id, 977);
    const out = await get(`/api/projects/${a.id}/issues?key=ISS-977`);
    expect(out.status).toBe(200);
    const issues = out.body?.items as Array<{ displayId: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.displayId).toBe('ISS-977');
  });

  // cm:why criterion 3.
  it('renders FD-977 where the project holds FD', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    await issueIn(a.id, 977);
    const out = await get(`/api/projects/${a.id}/issues`);
    const issues = out.body?.items as Array<{ displayId: string }>;
    expect(issues.map((i) => i.displayId)).toEqual(['FD-977']);
  });

  // cm:why criteria 4 and 5 — the legacy reference resolves forever, and the project's own resolves too.
  it.each(['ISS-977', 'FD-977'])('resolves ?key=%s on a project holding FD', async (key) => {
    const a = await project();
    await assign(a.id, 'FD');
    await issueIn(a.id, 977);
    const out = await get(`/api/projects/${a.id}/issues?key=${key}`);
    expect(out.status).toBe(200);
    const issues = out.body?.items as Array<{ displayId: string }>;
    expect(issues.map((i) => i.displayId)).toEqual(['FD-977']);
  });

  // cm:why criterion 16 — a prefix this project has never held names a different issue somewhere else, and answering with this project's 977 is the confusion the issue exists to end.
  it('refuses ?key=FP-977 on a project holding FD, naming the prefix sent', async () => {
    const a = await project();
    await assign(a.id, 'FD');
    await issueIn(a.id, 977);
    const out = await get(`/api/projects/${a.id}/issues?key=FP-977`);
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(out.body)).toContain('FP');
  });
});

describe('the project PATCH that sets a prefix', () => {
  async function patch(projectId: string, body: Record<string, unknown>) {
    const res = await app.request(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await signUserToken(userId)}`,
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  // cm:why criterion 2, through the door a person actually uses — every other prefix case arranges the row itself, so none of them proves the write works.
  it('persists a prefix named on its own and returns it', async () => {
    const a = await project();
    const out = await patch(a.id, { issuePrefix: 'FD' });
    expect(out.status).toBe(200);
    expect(out.body?.issuePrefix).toBe('FD');
    expect(await activePrefixOf(a.id)).toBe('FD');
  });

  // cm:guard the prefix is written through a SECOND table, so it has to move in the same transaction as the rest of the patch — applied outside it, a request that then fails on a sibling field renames the project and answers the caller with an error (codex review of ISS-992)
  it('leaves the prefix unset when a later field in the same patch fails', async () => {
    const a = await project();
    const out = await patch(a.id, { issuePrefix: 'FD', defaultDeviceId: randomUUID() });
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(await activePrefixOf(a.id)).toBeNull();
    expect(await heldIssuePrefixes(a.id)).toEqual([]);
  });

  // cm:why criterion 13 — the other half of the disclosure rule: a caller who can already see the holder is told which project it is, because withholding it there is an unhelpful refusal and no secret is kept.
  it('names the holder to a caller who can see it', async () => {
    const theirs = await project();
    await assign(theirs.id, 'FD');
    const mine = await project();
    const out = await patch(mine.id, { issuePrefix: 'FD' });
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.body)).toContain(theirs.name);
  });

  it('refuses a prefix another project holds without naming a project the caller cannot see', async () => {
    const other = (await createTestUser(harness.db)).id;
    const theirs = await createTestProject(harness.db, other);
    await assign(theirs.id, 'FD');
    const mine = await project();
    const out = await patch(mine.id, { issuePrefix: 'FD' });
    expect(out.status).toBe(409);
    expect(JSON.stringify(out.body)).not.toContain(theirs.slug);
    expect(JSON.stringify(out.body)).not.toContain(theirs.name);
  });
});
