/**
 * `key` on `GET /api/projects/:id/issues`, against real rows (ISS-991).
 *
 * The filter the caller reached for and did not have: it asked for `ISS-376`,
 * got the project's whole list at 200, and worked `items[0]`. Narrowing is the
 * half a mocked db cannot prove — that the WHERE reaches Postgres, that the
 * envelope's `total` counts the narrowed set, and that a sequence number
 * another project holds stays invisible.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Envelope = { items: { displayId: string; issSeq: number }[]; total: number };

describe('GET /api/projects/:id/issues — the `key` filter (ISS-991)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const { issueProjectRoutes } = await import('../../src/issues/routes.js');
    const { searchRoutes } = await import('../../src/issues/search.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    ({ signUserToken } = await import('../../src/auth/jwt.js'));

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', issueProjectRoutes);
    app.route('/api/projects', searchRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function member() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    return { user, project };
  }

  async function seedIssue(args: {
    projectId: string;
    createdById: string;
    issSeq: number;
    title: string;
    status?: string;
  }) {
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${randomUUID()}, ${args.projectId}, ${args.issSeq}, ${args.title},
              ${args.status ?? 'open'}, ${args.createdById})
    `);
  }

  async function get(projectId: string, userId: string, query: string, path = 'issues') {
    const res = await app.request(`/api/projects/${projectId}/${path}?${query}`, {
      headers: { authorization: `Bearer ${await signUserToken(userId)}` },
    });
    return { res, body: (await res.json()) as Envelope & Record<string, unknown> };
  }

  it('returns only the issue the display id names', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 376, title: 'wanted' });
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 383, title: 'the one' });
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 12, title: 'a third' });

    const { res, body } = await get(project.id, user.id, 'key=ISS-376');

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-376']);
  });

  it('leaves out the issue an unfiltered page would have put first', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 376, title: 'wanted' });
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 383, title: 'the one' });

    const { body } = await get(project.id, user.id, 'key=ISS-376');

    expect(body.items.some((i) => i.issSeq === 383)).toBe(false);
  });

  it('takes the bare sequence number for the same issue', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 376, title: 'wanted' });
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 383, title: 'the one' });

    const { body } = await get(project.id, user.id, 'key=376');

    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-376']);
  });

  it('answers an empty page for a sequence number the project does not hold', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 1, title: 'the only' });

    const { res, body } = await get(project.id, user.id, 'key=ISS-9999');

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('does not return another project’s issue of that sequence number', async () => {
    const { user, project } = await member();
    const other = await member();
    await seedIssue({
      projectId: other.project.id,
      createdById: other.user.id,
      issSeq: 376,
      title: 'someone else’s',
    });

    const { body } = await get(project.id, user.id, 'key=ISS-376');

    expect(body.items).toEqual([]);
  });

  it('counts the narrowed set rather than the project', async () => {
    const { user, project } = await member();
    for (const issSeq of [1, 2, 3, 376]) {
      await seedIssue({ projectId: project.id, createdById: user.id, issSeq, title: `t${issSeq}` });
    }

    const { body } = await get(project.id, user.id, 'key=ISS-376');

    expect(body.total).toBe(1);
  });

  it('returns a ten-digit sequence number the column can hold', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 1_000_000_000,
      title: 'a big one',
    });

    const { res, body } = await get(project.id, user.id, 'key=ISS-1000000000');

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.issSeq)).toEqual([1_000_000_000]);
  });

  it('refuses a sequence number past int4 rather than handing it to Postgres', async () => {
    const { user, project } = await member();

    const { res } = await get(project.id, user.id, 'key=2147483648');

    expect(res.status).toBe(400);
  });

  it('refuses a malformed key rather than ignoring it', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 1, title: 'the only' });

    const { res, body } = await get(project.id, user.id, 'key=not-a-key');

    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).toContain('key');
  });

  it('still narrows by status', async () => {
    const { user, project } = await member();
    await seedIssue({ projectId: project.id, createdById: user.id, issSeq: 1, title: 'o' });
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2,
      title: 'c',
      status: 'closed',
    });

    const { body } = await get(project.id, user.id, 'status=open');

    expect(body.items.map((i) => i.issSeq)).toEqual([1]);
  });

  it('refuses an unregistered parameter on the sibling search route too', async () => {
    const { user, project } = await member();

    const { res, body } = await get(project.id, user.id, 'nonsense=1', 'issues/search');

    expect(res.status).toBe(400);
    expect(body.message).toContain('nonsense');
  });
});
