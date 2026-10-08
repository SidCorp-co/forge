/**
 * The harness the issue-search key suites share (ISS-1334): a real Postgres, the search route, and
 * the MCP list, with the seeds that put a key's neighbours beside it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from './index.js';

export type Envelope = {
  items: { displayId: string; issSeq: number; matchedFields?: string[] }[];
  total: number;
};
export type Refusal = { code: string; message: string };

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let forgeIssuesTool: typeof import('../../src/mcp/tools/forge-issues.js').forgeIssuesTool;

/** Registers the database and app for the calling file; call it once at its top level. */
export function useIssueSearchHarness() {
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
}

export async function member() {
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

export async function holdPrefixes(projectId: string, active: string, retired: string[] = []) {
  for (const prefix of [active, ...retired]) {
    await harness.db.execute(
      sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${projectId}, ${prefix})`,
    );
  }
  await harness.db.execute(
    sql`UPDATE projects SET issue_prefix = ${active} WHERE id = ${projectId}`,
  );
}

export async function seedIssue(args: {
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
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, priority,
                        created_by_id, merged_at, archived_at)
    VALUES (${id}, ${args.projectId}, ${args.issSeq}, ${args.title},
            ${args.description ?? null}, ${status}, ${args.priority ?? 'medium'},
            ${args.createdById},
            CASE WHEN ${status} = 'closed' THEN now() END,
            CASE WHEN ${args.archived ?? false} THEN now() END)
  `);
  return id;
}

/** ISS-1280 and the three neighbours whose bodies cite it — the shape the owner hit. */
export async function neighbourhood(projectId: string, createdById: string) {
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

export async function search(projectId: string, userId: string, q: string, extra = '') {
  const res = await app.request(
    `/api/projects/${projectId}/issues/search?q=${encodeURIComponent(q)}${extra}`,
    { headers: { authorization: `Bearer ${await signUserToken(userId)}` } },
  );
  return { res, body: (await res.json()) as Envelope & Refusal };
}

export function mcpList(userId: string, projectId: string, search: string) {
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

/** A prefix whose project is gone: the row stays, owned by nobody, and the prefix stays spent. */
export async function spendPrefix(prefix: string) {
  await harness.db.execute(
    sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (NULL, ${prefix})`,
  );
}
