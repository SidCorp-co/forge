/**
 * ISS-1327 — what counts as evidence that an issue's work landed, per project shape, against a
 * real Postgres over migration 0315.
 *
 * Every door is driven at its own runtime: the REST mark and detail routes, the `forge_issues` tool
 * over a loopback MCP client, the kernel's transition writer, the entry criterion and the
 * release-record blocker. What each of them decides is `landing-evidence.ts`'s answer, and the
 * point of running them all is that none of them decides it a second time.
 *
 * The field this was measured on: a storefront project (kind `website`) whose checkout is a
 * control folder of one commit, where three issues were refused `CLOSE_REQUIRES_SHIPPED` and a
 * fourth closed against that one commit, which holds none of its work.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
  mintPat: typeof import('../../src/auth/pat.js')['mintPat'];
  transitionIssueStatus: typeof import('../../src/issues/apply-transition.js')['transitionIssueStatus'];
  findUnmetEntryCriteria: typeof import('../../src/issues/entry-criteria.js')['findUnmetEntryCriteria'];
  collectReleaseBlockers: typeof import('../../src/release-batch/blockers.js')['collectReleaseBlockers'];
};

const LANDING = 'https://mowmentbrand.com/products/linen-tee';
const CONTROL_FOLDER_COMMIT = '07f73960b2ce7ea1dfa1f050ec64d9bd0c80fe67';

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

type World = { projectId: string; userId: string; token: string; pat: string };

async function world(kind: 'standard' | 'website'): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(sql`UPDATE projects SET kind = ${kind} WHERE id = ${project.id}`);
  return {
    projectId: project.id,
    userId: user.id,
    token: await mods.signUserToken(user.id),
    pat: (await mods.mintPat({ userId: user.id, name: 'landing-e2e' })).plaintext,
  };
}

let seq = 0;
async function seedIssue(
  w: World,
  mark: { mergedAt?: boolean; sha?: string; landing?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                        merged_at, merged_commit_sha, merged_landing)
    VALUES (${id}, ${w.projectId}, ${++seq}, 'landing', 'awaiting_release', ${w.userId},
            ${mark.mergedAt || mark.sha || mark.landing ? sql`now()` : null},
            ${mark.sha ?? null}, ${mark.landing ?? null})
  `);
  return id;
}

async function stored(id: string) {
  const rows = await harness.db.execute<{
    status: string;
    merged_at: unknown;
    merged_landing: string | null;
  }>(sql`SELECT status, merged_at, merged_landing FROM issues WHERE id = ${id}`);
  return rows[0] as { status: string; merged_at: unknown; merged_landing: string | null };
}

function rest(method: 'POST' | 'DELETE' | 'GET', path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function tool(pat: string, args: Record<string, unknown>) {
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

async function close(w: World, id: string) {
  return mods.transitionIssueStatus(
    { id, projectId: w.projectId, status: 'awaiting_release', reopenCount: 0 },
    'closed',
    { type: 'user', id: w.userId },
  );
}

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error('expected a refusal, and the call went through');
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
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
  app.onError(mods.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('a project whose work lands outside git (kind website)', () => {
  it('closes an issue marked through forge_issues with data.landing', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    const marked = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod', landing: LANDING },
    });
    expect(marked.isError, marked.text).toBe(false);
    expect(marked.json().mark).toBe('landed');

    await close(w, id);
    expect(await stored(id)).toMatchObject({ status: 'closed', merged_landing: LANDING });
  });

  it('answers forge_issues get with mergeMark landed and the landing itself', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { landing: LANDING });
    const got = (await tool(w.pat, { action: 'get', documentId: id })).json();
    expect(got.mergeMark).toBe('landed');
    expect(got.mergedLanding).toBe(LANDING);
  });

  it('closes an issue marked at the REST door with landing, whose detail names the shape', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: LANDING,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mark).toBe('landed');

    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail).toMatchObject({
      landingShape: 'outside_git',
      mergeMark: 'landed',
      mergedLanding: LANDING,
    });

    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('refuses the close of a bare timestamp, naming data.landing — the ISS-49 shape', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { mergedAt: true });
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`mark_merged` carrying `data.landing`');
    expect(refusal.message).toContain('`unmark` it first');
    expect((await stored(id)).status).toBe('awaiting_release');

    // The remedy the refusal names, taken whole, is what closes it.
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    const marked = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-49',
      landing: LANDING,
    });
    expect((await marked.json()).mark).toBe('landed');
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('refuses the close of an issue with no mark at all, naming the same route', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('`data.landing`');
    expect((await stored(id)).status).toBe('awaiting_release');
  });

  it('refuses a mark naming no landing at both doors, and writes no merged_at', async () => {
    const w = await world('website');
    const id = await seedIssue(w);

    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      commit: CONTROL_FOLDER_COMMIT,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('LANDING_REQUIRED');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod' },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('LANDING_REQUIRED');

    expect((await stored(id)).merged_at).toBeNull();
  });

  it('fails merged_mark on an issue whose mark names no landing', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { mergedAt: true });
    const short = await mods.findUnmetEntryCriteria({ issueId: id, declared: ['merged_mark'] });
    expect(short?.unmet.map((u) => u.key)).toEqual(['merged_mark']);
  });

  it('passes merged_mark on an issue whose mark names a landing', async () => {
    const w = await world('website');
    const id = await seedIssue(w, { landing: LANDING });
    expect(
      await mods.findUnmetEntryCriteria({ issueId: id, declared: ['merged_mark'] }),
    ).toBeNull();
  });

  it('lists an issue whose mark names no landing under RELEASE_WORK_UNMERGED at the record door', async () => {
    const w = await world('website');
    // A one-entry chain and a live deploy binding are a release gate at all; with no probe the
    // release is recorded unverified (ISS-1321), so the only reason left is the roster's own.
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', release_chain = '[{"branch":"main"}]'::jsonb
      WHERE id = ${w.projectId}
    `);
    const connection = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connection}, 'user', ${w.userId}, 'coolify', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
      VALUES (${connection}, ${w.projectId}, 'coolify', 'deploy', ARRAY['live'], true, '{}'::jsonb)
    `);
    const bare = await seedIssue(w, { mergedAt: true });
    const landed = await seedIssue(w, { landing: LANDING });
    const report = await mods.collectReleaseBlockers(w.projectId, {
      issueIds: [bare, landed],
      door: 'record',
    });
    const unmerged = report.blockers.find((b) => b.code === 'RELEASE_WORK_UNMERGED');
    expect(unmerged?.details, JSON.stringify(report.blockers)).toEqual({ issueIds: [bare] });
  });

  it('clears the landing with unmark, so the next mark records the landing it is sent', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    await rest('POST', `/api/issues/${id}/merge`, w.token, { target: 'ISS-38', landing: LANDING });
    expect((await rest('DELETE', `/api/issues/${id}/merge`, w.token, {})).status).toBe(200);
    expect(await stored(id)).toMatchObject({ merged_at: null, merged_landing: null });

    const corrected = 'cms://entries/lookbook-autumn';
    await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing: corrected,
    });
    expect((await stored(id)).merged_landing).toBe(corrected);
  });
});

describe('a project that lands in git (kind standard) closes exactly as before', () => {
  it('closes on an asserted mark', async () => {
    const w = await world('standard');
    const id = await seedIssue(w, { mergedAt: true });
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it('closes on an observed mark', async () => {
    const w = await world('standard');
    const id = await seedIssue(w, { sha: CONTROL_FOLDER_COMMIT });
    await close(w, id);
    expect((await stored(id)).status).toBe('closed');
  });

  it("refuses a close with no mark in today's words, naming mark_merged and no landing", async () => {
    const w = await world('standard');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() => close(w, id));
    expect(refusal.code).toBe('CLOSE_REQUIRES_SHIPPED');
    expect(refusal.message).toContain('this issue carries no `merged_at`');
    expect(refusal.message).toContain('`mark_merged` naming where it landed, then close');
    expect(refusal.message).not.toContain('landing');
  });

  it('refuses a landing at both doors by name, and writes no merged_at', async () => {
    const w = await world('standard');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'main',
      landing: LANDING,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('LANDING_NOT_THIS_SHAPE');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'base', landing: LANDING },
    });
    expect(viaTool.text).toContain('LANDING_NOT_THIS_SHAPE');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it('serves landingShape git on the detail answer', async () => {
    const w = await world('standard');
    const id = await seedIssue(w);
    const detail = await (await rest('GET', `/api/issues/${id}`, w.token)).json();
    expect(detail.landingShape).toBe('git');
  });
});

describe('the landing field is refused malformed, at both doors and in the column', () => {
  it.each([
    ['blank', '   '],
    ['past 2000 characters', 'x'.repeat(2001)],
  ])('refuses a %s landing naming the field', async (_what, landing) => {
    const w = await world('website');
    const id = await seedIssue(w);
    const res = await rest('POST', `/api/issues/${id}/merge`, w.token, {
      target: 'ISS-38',
      landing,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('landing');

    const viaTool = await tool(w.pat, {
      action: 'mark_merged',
      data: { issueId: id, target: 'prod', landing },
    });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toContain('landing');
    expect((await stored(id)).merged_at).toBeNull();
  });

  it.each([
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses a landing of only %s in the table itself', async (_what, landing) => {
    const w = await world('website');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() =>
      harness.db.execute(
        sql`UPDATE issues SET merged_at = now(), merged_landing = ${landing} WHERE id = ${id}`,
      ),
    );
    const chain = [refusal.message, String((refusal as { cause?: unknown }).cause ?? '')].join(
      '\n',
    );
    expect(chain).toContain('issues_merged_landing_chk');
  });

  it('refuses a landing with no merged_at in the table itself, whatever wrote it', async () => {
    const w = await world('website');
    const id = await seedIssue(w);
    const refusal = await refusalOf(() =>
      harness.db.execute(sql`UPDATE issues SET merged_landing = ${LANDING} WHERE id = ${id}`),
    );
    const chain = [refusal.message, String((refusal as { cause?: unknown }).cause ?? '')].join(
      '\n',
    );
    expect(chain).toContain('issues_merged_landing_chk');
  });
});
