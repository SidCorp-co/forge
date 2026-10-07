/**
 * A key typed into the issues search, against real rows (ISS-1334).
 *
 * The search answered `q=ISS-1280` with the issues whose bodies cite ISS-1280 and never ISS-1280
 * itself. What a mocked db cannot show: that the key reaches `iss_seq` in Postgres, that the
 * prefixes held in `issue_prefix_aliases` decide what reads as a key, and that the MCP list answers
 * the same as the route.
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

type Envelope = {
  items: { displayId: string; issSeq: number; matchedFields?: string[] }[];
  total: number;
};
type Refusal = { code: string; message: string };

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let forgeIssuesTool: typeof import('../../src/mcp/tools/forge-issues.js').forgeIssuesTool;

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
  process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
  process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

  const { searchRoutes } = await import('../../src/issues/search.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ forgeIssuesTool } = await import('../../src/mcp/tools/forge-issues.js'));

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
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

async function holdPrefixes(projectId: string, active: string, retired: string[] = []) {
  for (const prefix of [active, ...retired]) {
    await harness.db.execute(
      sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${projectId}, ${prefix})`,
    );
  }
  await harness.db.execute(
    sql`UPDATE projects SET issue_prefix = ${active} WHERE id = ${projectId}`,
  );
}

async function seedIssue(args: {
  projectId: string;
  createdById: string;
  issSeq: number;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  archived?: boolean;
}) {
  const status = args.status ?? 'open';
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, priority,
                        created_by_id, merged_at, archived_at)
    VALUES (${randomUUID()}, ${args.projectId}, ${args.issSeq}, ${args.title},
            ${args.description ?? null}, ${status}, ${args.priority ?? 'medium'},
            ${args.createdById},
            CASE WHEN ${status} = 'closed' THEN now() END,
            CASE WHEN ${args.archived ?? false} THEN now() END)
  `);
}

/** ISS-1280 and the three neighbours whose bodies cite it — the shape the owner hit. */
async function neighbourhood(projectId: string, createdById: string) {
  await seedIssue({
    projectId,
    createdById,
    issSeq: 1279,
    title: 'before',
    description: 'see ISS-1280',
  });
  await seedIssue({ projectId, createdById, issSeq: 1280, title: 'the release door' });
  await seedIssue({
    projectId,
    createdById,
    issSeq: 1281,
    title: 'after',
    description: 'ISS-1280 again',
  });
  await seedIssue({
    projectId,
    createdById,
    issSeq: 1282,
    title: 'later',
    description: 'cf ISS-1280',
  });
}

async function search(projectId: string, userId: string, q: string, extra = '') {
  const res = await app.request(
    `/api/projects/${projectId}/issues/search?q=${encodeURIComponent(q)}${extra}`,
    { headers: { authorization: `Bearer ${await signUserToken(userId)}` } },
  );
  return { res, body: (await res.json()) as Envelope & Refusal };
}

function mcpList(userId: string, projectId: string, search: string) {
  const tool = forgeIssuesTool({
    principal: { userId, agency: 'human', tokenId: null, deviceId: null, projectIds: null },
    projectSlug: null,
    boundProjectId: null,
    // biome-ignore lint/suspicious/noExplicitAny: the factory's context, narrowed to what runs here
  } as any);
  return tool.handler({ action: 'list', projectId, filters: { search } }) as Promise<{
    issues: { issueId: string }[];
  }>;
}

describe('GET /api/projects/:id/issues/search — a key finds its issue (ISS-1334)', () => {
  it('answers ISS-1280 with ISS-1280 alone, not the issues citing it', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, 'ISS-1280');

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.displayId)).toEqual(['ISS-1280']);
    expect(body.total).toBe(1);
  });

  it.each(['1280', 'iss-1280', '  ISS-1280  '])('answers %j with the same row', async (q) => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { res, body } = await search(project.id, user.id, q);

    expect(res.status).toBe(200);
    expect(body.items.map((i) => i.issSeq)).toEqual([1280]);
  });

  it('resolves the owner’s keys in a project with a prefix of its own, current, retired and legacy', async () => {
    const { user, project } = await member();
    await holdPrefixes(project.id, 'FP', ['FPL']);
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2630,
      title: 'a',
      priority: 'critical',
    });
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 2295,
      title: 'b',
      description: 'FP-2630',
    });

    for (const [q, seq] of [
      ['ISS-2630', 2630],
      ['ISS-2295', 2295],
      ['FP-2630', 2630],
      ['fpl-2295', 2295],
    ] as const) {
      const { res, body } = await search(project.id, user.id, q);
      expect(res.status, q).toBe(200);
      expect(
        body.items.map((i) => i.displayId),
        q,
      ).toEqual([`FP-${seq}`]);
    }
  });

  it('answers a key whose issue is archived, as the list route’s key does', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 7,
      title: 'gone',
      status: 'closed',
      archived: true,
    });

    const { body } = await search(project.id, user.id, 'ISS-7');

    expect(body.items.map((i) => i.issSeq)).toEqual([7]);
  });
});

describe('GET /api/projects/:id/issues/search — a key it cannot answer is refused by name (ISS-1334)', () => {
  it.each(['ISS-9999', '9999'])(
    'refuses %j by name when the project holds no such issue',
    async (q) => {
      const { user, project } = await member();
      await neighbourhood(project.id, user.id);
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 1,
        title: 'mentions ISS-9999 and 9999',
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(404);
      expect(body.code).toBe('ISSUE_KEY_NOT_HELD');
      expect(body.message).toContain('ISS-9999');
    },
  );

  it('refuses a key whose prefix another project holds, naming the prefix', async () => {
    const { user, project } = await member();
    const other = await member();
    await holdPrefixes(other.project.id, 'OTH');
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 5,
      title: 'cites OTH-5',
    });

    const { res, body } = await search(project.id, user.id, 'OTH-5');

    expect(res.status).toBe(400);
    expect(body.code).toBe('ISSUE_KEY_FOREIGN_PREFIX');
    expect(body.message).toContain('`OTH`');
    expect(body.message).toContain('`ISS`');
  });

  it.each(['0', 'ISS-0', '2147483648', '21474836470'])(
    'refuses %j as a number no issue can carry',
    async (q) => {
      const { user, project } = await member();
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 1,
        title: `about ${q}`,
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(400);
      expect(body.code).toBe('ISSUE_KEY_OUT_OF_RANGE');
    },
  );
});

describe('issue search — text, filters and the MCP list beside a key (ISS-1334)', () => {
  it.each(['UTF-8', 'UTF-9999', 'UTF-0'])(
    'searches %j as text when no project ever held its prefix',
    async (q) => {
      const { user, project } = await member();
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 3,
        title: `breaks on ${q} input`,
      });
      await seedIssue({
        projectId: project.id,
        createdById: user.id,
        issSeq: 4,
        title: 'unrelated',
      });

      const { res, body } = await search(project.id, user.id, q);

      expect(res.status).toBe(200);
      expect(body.items.map((i) => i.issSeq)).toEqual([3]);
      expect(body.items[0]?.matchedFields).toEqual(['title']);
    },
  );

  it('searches a query with no key shape as text, newest first as before', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const { body } = await search(project.id, user.id, 'ISS-1280 again');

    expect(body.items.map((i) => i.issSeq)).toEqual([1281]);
  });

  it('still narrows a key by status and priority', async () => {
    const { user, project } = await member();
    await seedIssue({
      projectId: project.id,
      createdById: user.id,
      issSeq: 8,
      title: 'x',
      priority: 'high',
    });

    const atOpen = await search(project.id, user.id, 'ISS-8', '&status=open&priority=high');
    const atClosed = await search(project.id, user.id, 'ISS-8', '&status=closed');
    const atLow = await search(project.id, user.id, 'ISS-8', '&priority=low');

    expect(atOpen.body.items.map((i) => i.issSeq)).toEqual([8]);
    expect(atClosed.res.status).toBe(200);
    expect(atClosed.body.items).toEqual([]);
    expect(atLow.body.items).toEqual([]);
  });

  it('answers the MCP list’s key search with the one row, and refuses an unheld key the same way', async () => {
    const { user, project } = await member();
    await neighbourhood(project.id, user.id);

    const hit = await mcpList(user.id, project.id, 'ISS-1280');

    expect(hit.issues.map((i) => i.issueId)).toEqual(['ISS-1280']);
    await expect(mcpList(user.id, project.id, 'ISS-9999')).rejects.toThrow(
      /^NOT_FOUND: .*ISS-9999/,
    );
    await expect(mcpList(user.id, project.id, '0')).rejects.toThrow(/^BAD_REQUEST: /);
  });
});
