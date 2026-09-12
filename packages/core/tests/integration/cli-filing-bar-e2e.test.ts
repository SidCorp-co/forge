/**
 * The two bodies the CLI layer refuses are ACCEPTED through the API (ISS-985).
 *
 * The refusal half is unit-tested. This is the half that catches the wrong fix: a required section
 * or a required category pushed DOWN into the create route or the tool would break every existing
 * caller that legitimately omits one, and a suite that only watched the layer refuse would pass.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IssueCreateWriter } from '../../src/issues/create-service.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { connectClientAsPat, parseToolResult } from '../helpers/mcp-harness.js';

const COMPLETE = [
  '## Outcome\n\nthe body carries every section its kind requires',
  '## Rules\n\nnothing beneath the CLI layer becomes required',
  '## Out of scope\n\nthe plugin repo is reached by issue',
].join('\n\n');

/** The same body with `## Outcome` taken out: what the layer refuses by name. */
const NO_SECTION = COMPLETE.split('\n\n').slice(1).join('\n\n');

const TITLE = 'a body the CLI layer refuses is still accepted through the API';

type Mods = {
  fileIssueThroughCli: typeof import('../../src/cli/file-issue.js')['fileIssueThroughCli'];
  issueProjectRoutes: typeof import('../../src/issues/routes.js')['issueProjectRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

describe('ISS-985 — a stricter front-end that moved nothing beneath it', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const [cliMod, routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/cli/file-issue.js'),
      import('../../src/issues/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      fileIssueThroughCli: cliMod.fileIssueThroughCli,
      issueProjectRoutes: routesMod.issueProjectRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };
    app = new Hono();
    app.route('/api/projects', mods.issueProjectRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const token = await mods.signUserToken(user.id);
    const { mintPat } = await import('../../src/auth/pat.js');
    const { plaintext } = await mintPat({ userId: user.id, name: `cli-bar-${randomUUID()}` });
    return { user, project, token, pat: plaintext };
  }

  async function rowsTitled(title: string): Promise<number> {
    const rows = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM issues WHERE title = ${title}`,
    );
    return Number((rows as unknown as Array<{ n: string }>)[0]?.n ?? 0);
  }

  function postRest(projectId: string, token: string, body: Record<string, unknown>) {
    return app.request(`/api/projects/${projectId}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  const cases = [
    [
      'a body missing a required section',
      { title: TITLE, description: NO_SECTION, category: 'feature' },
    ],
    ['a filing naming no category', { title: TITLE, description: COMPLETE }],
  ] as const;

  // cm:guard the layer must refuse BOTH bodies for the API assertions below to mean anything — an API accepting what nothing refuses proves no divergence was preserved
  it.each(cases)('%s is refused by the CLI layer', async (_name, payload) => {
    const { project, user } = await seed();
    const writer = {
      createdById: user.id,
      createdVia: 'mcp',
      actor: { agency: 'agent', kind: 'user', id: user.id },
    } as unknown as IssueCreateWriter;
    const answer = await mods.fileIssueThroughCli(
      {
        projectId: project.id,
        title: payload.title,
        body: payload.description,
        category: 'category' in payload ? payload.category : null,
      },
      writer,
    );
    expect(answer.filed).toBe(false);
    expect(await rowsTitled(TITLE)).toBe(0);
  });

  it.each(cases)('%s is accepted through the REST issue-create route', async (_name, payload) => {
    const { project, token } = await seed();
    const res = await postRest(project.id, token, payload);
    expect(res.status).toBe(201);
    expect(await rowsTitled(TITLE)).toBe(1);
  });

  it.each(cases)(
    '%s is accepted through the forge_issues create action',
    async (_name, payload) => {
      const { project, pat } = await seed();
      const ctx = await connectClientAsPat(pat);
      try {
        const res = await ctx.client.callTool({
          name: 'forge_issues',
          arguments: {
            action: 'create',
            projectId: project.id,
            data: { ...payload, status: 'draft' },
          },
        });
        const created = parseToolResult(res as never) as { documentId?: string };
        expect(created.documentId).toBeTruthy();
        expect(await rowsTitled(TITLE)).toBe(1);
      } finally {
        await ctx.close();
      }
    },
  );
});
