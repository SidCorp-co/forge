/**
 * ISS-1327 — the world both landing e2e files stand in: a real Postgres over migration 0315, the
 * REST mark and detail routes, the `forge_issues` tool over a loopback MCP client, and the kernel's
 * transition writer. `useLandingHarness()` registers the hooks; the helpers read what they set.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat } from '../helpers/mcp-harness.js';

type Mods = {
  issueMergeRoutes: typeof import('../../src/issues/merge-routes.js')['issueMergeRoutes'];
  issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  issueProjectRoutes: typeof import('../../src/issues/routes.js')['issueProjectRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
  mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
  transitionIssueStatus: typeof import('../../src/issues/apply-transition.js')['transitionIssueStatus'];
  findUnmetEntryCriteria: typeof import('../../src/issues/entry-criteria.js')['findUnmetEntryCriteria'];
  collectReleaseBlockers: typeof import('../../src/release-batch/blockers.js')['collectReleaseBlockers'];
};

export const LANDING = 'https://mowmentbrand.com/products/linen-tee';
export const CONTROL_FOLDER_COMMIT = '07f73960b2ce7ea1dfa1f050ec64d9bd0c80fe67';

let database: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

export type World = { projectId: string; userId: string; token: string; pat: string };

export async function world(kind: 'standard' | 'website'): Promise<World> {
  const user = await createTestUser(database.db);
  await database.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(database.db, user.id);
  await createTestProjectMember(database.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await database.db.execute(sql`UPDATE projects SET kind = ${kind} WHERE id = ${project.id}`);
  return {
    projectId: project.id,
    userId: user.id,
    token: await mods.signUserToken(user.id),
    pat: (await mods.mintPat({ userId: user.id, name: 'landing-e2e' })).plaintext,
  };
}

let seq = 0;
export async function seedIssue(
  w: World,
  mark: { mergedAt?: boolean; sha?: string; landing?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await database.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                        merged_at, merged_commit_sha, merged_landing)
    VALUES (${id}, ${w.projectId}, ${++seq}, 'landing', 'awaiting_release', ${w.userId},
            ${mark.mergedAt || mark.sha || mark.landing ? sql`now()` : null},
            ${mark.sha ?? null}, ${mark.landing ?? null})
  `);
  return id;
}

/** The mark columns and the thread, together: a refused call must leave both as they were. */
export async function snapshot(id: string) {
  const rows = await database.db.execute<{
    merged_at: unknown;
    merged_commit_sha: string | null;
    merged_landing: string | null;
    comments: number;
  }>(sql`
    SELECT i.merged_at, i.merged_commit_sha, i.merged_landing,
           (SELECT count(*)::int FROM comments c WHERE c.issue_id = i.id) AS comments
    FROM issues i WHERE i.id = ${id}
  `);
  return rows[0];
}

export async function stored(id: string) {
  const rows = await database.db.execute<{
    status: string;
    merged_at: unknown;
    merged_landing: string | null;
  }>(sql`SELECT status, merged_at, merged_landing FROM issues WHERE id = ${id}`);
  return rows[0] as { status: string; merged_at: unknown; merged_landing: string | null };
}

export function rest(
  method: 'POST' | 'DELETE' | 'GET' | 'PATCH',
  path: string,
  token: string,
  body?: unknown,
) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function tool(pat: string, args: Record<string, unknown>) {
  const ctx = await connectClientAsPat(pat);
  try {
    const res = (await ctx.client.callTool({ name: 'forge_issues', arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0]?.text ?? '';
    return { isError: res.isError === true, text, json: () => JSON.parse(text) };
  } finally {
    await ctx.close();
  }
}

export async function close(w: World, id: string) {
  return mods.transitionIssueStatus(
    { id, projectId: w.projectId, status: 'awaiting_release', reopenCount: 0 },
    'closed',
    { type: 'user', id: w.userId },
  );
}

export async function refusalOf(
  run: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error('expected a refusal, and the call went through');
}

/** The database and the modules loaded against it, for a case that reaches past the helpers. */
export const harness = {
  get db() {
    return database.db;
  },
  get mods() {
    return mods;
  },
};

export function useLandingHarness(): void {
  beforeAll(async () => {
    database = await setupTestDatabase();
    process.env.DATABASE_URL = database.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const [mergeMod, routesMod, jwtMod, errMod, patMod, transitionMod, criteriaMod, blockersMod] =
      await Promise.all([
        import('../../src/issues/merge-routes.js'),
        import('../../src/issues/routes.js'),
        import('../../src/auth/jwt.js'),
        import('../../src/middleware/error.js'),
        import('../../src/auth/pat.js'),
        import('../../src/issues/apply-transition.js'),
        import('../../src/issues/entry-criteria.js'),
        import('../../src/release-batch/blockers.js'),
      ]);
    mods = {
      issueMergeRoutes: mergeMod.issueMergeRoutes,
      issueRoutes: routesMod.issueRoutes,
      issueProjectRoutes: routesMod.issueProjectRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
      mintPat: patMod.mintPat,
      transitionIssueStatus: transitionMod.transitionIssueStatus,
      findUnmetEntryCriteria: criteriaMod.findUnmetEntryCriteria,
      collectReleaseBlockers: blockersMod.collectReleaseBlockers,
    };
    app = new Hono();
    app.route('/api/issues', mods.issueMergeRoutes);
    app.route('/api/issues', mods.issueRoutes);
    app.route('/api/projects', mods.issueProjectRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (database) await database.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(database.db);
  });
}
