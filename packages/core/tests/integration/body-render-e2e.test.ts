/**
 * The read half of ISS-967, over HTTP against real Postgres.
 *
 * The unit suite proves `bodyNodes` on strings. What only the mounted routes
 * can answer: that a component body written through one door comes BACK as a
 * tree on the two surfaces web actually reads — `GET /api/issues/:id` and the
 * comment thread — and that the composer's two routes answer without a row.
 * Wire those up wrong and every unit test still passes while the screen shows
 * literal `<forge-…>` markup, which is the defect this issue exists to fix.
 */

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

type BodyNodeish = { type: string; name?: string; attrs?: Record<string, string> };

const REVIEW =
  '<forge-review sha="60e8d635" verdict="approve">' +
  '<forge-finding file="a.ts" severity="nit">tidy</forge-finding>' +
  '<forge-summary><p>ran the suite</p></forge-summary>' +
  '</forge-review>';

type Mods = {
  issueRoutes: typeof import('../../src/issues/routes.js').issueRoutes;
  bodyRoutes: typeof import('../../src/body/routes.js').bodyRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
};

describe('ISS-967 component bodies reach a client as a tree', () => {
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

    const [issuesMod, bodyMod, jwtMod, errMod] = await Promise.all([
      import('../../src/issues/routes.js'),
      import('../../src/body/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      issueRoutes: issuesMod.issueRoutes,
      bodyRoutes: bodyMod.bodyRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
    };

    app = new Hono();
    app.route('/api/issues', mods.issueRoutes);
    app.route('/api/body', mods.bodyRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`,
    );
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'render fixture', ${owner.id})
      RETURNING id
    `);
    const jwt = await mods.signUserToken(owner.id);
    return { issueId: (rows[0] as { id: string }).id, jwt };
  }

  const auth = (jwt: string) => ({
    authorization: `Bearer ${jwt}`,
    'content-type': 'application/json',
  });

  it('hands the detail payload a tree for a description written as components', async () => {
    const { issueId, jwt } = await seed();
    const patch = await app.request(`/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: auth(jwt),
      body: JSON.stringify({ description: REVIEW, descriptionFormat: 'html' }),
    });
    expect(patch.status).toBe(200);

    const res = await app.request(`/api/issues/${issueId}`, { headers: auth(jwt) });
    const detail = (await res.json()) as {
      descriptionFormat: string;
      descriptionTemplate: string | null;
      descriptionNodes: BodyNodeish[] | null;
    };
    expect(detail.descriptionFormat).toBe('html');
    expect(detail.descriptionTemplate).toBe('forge-review');
    expect(detail.descriptionNodes?.[0]).toMatchObject({
      type: 'element',
      name: 'forge-review',
      attrs: { sha: '60e8d635', verdict: 'approve' },
    });
  });

  it('leaves a markdown description without a tree, so it still renders as markdown', async () => {
    const { issueId, jwt } = await seed();
    await app.request(`/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: auth(jwt),
      body: JSON.stringify({ description: '## Plain\n\n- one' }),
    });
    const res = await app.request(`/api/issues/${issueId}`, { headers: auth(jwt) });
    const detail = (await res.json()) as { descriptionNodes: unknown };
    expect(detail.descriptionNodes).toBeNull();
  });

  it('hands each comment its own tree', async () => {
    const { issueId, jwt } = await seed();
    const posted = await app.request(`/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify({ body: REVIEW, format: 'html' }),
    });
    expect(posted.status).toBe(201);

    const res = await app.request(`/api/issues/${issueId}/comments`, { headers: auth(jwt) });
    const page = (await res.json()) as {
      items: { format: string; nodes: BodyNodeish[] | null }[];
    };
    expect(page.items[0]?.format).toBe('html');
    expect(page.items[0]?.nodes?.[0]).toMatchObject({ name: 'forge-review' });
  });

  it('answers the registry the composer offers components from', async () => {
    const { jwt } = await seed();
    const res = await app.request('/api/body/components', { headers: auth(jwt) });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: { name: string; root: boolean }[] };
    expect(items.find((d) => d.name === 'forge-review')?.root).toBe(true);
  });

  it('previews the bytes a save would store, without storing them', async () => {
    const { jwt } = await seed();
    const res = await app.request('/api/body/preview', {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify({ raw: 'just prose' }),
    });
    const preview = (await res.json()) as { format: string; body: string; nodes: unknown };
    expect(preview.format).toBe('markdown');
    expect(preview.nodes).toBeNull();

    const html = await app.request('/api/body/preview', {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify({ raw: REVIEW }),
    });
    const rendered = (await html.json()) as { template: string; nodes: BodyNodeish[] };
    expect(rendered.template).toBe('forge-review');
    expect(rendered.nodes[0]).toMatchObject({ name: 'forge-review' });
  });

  it('refuses an invalid draft in the preview with the same named 400 the save gives', async () => {
    const { jwt } = await seed();
    const res = await app.request('/api/body/preview', {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify({ raw: '<forge-review sha="60e8d635" verdict="maybe"></forge-review>' }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { message: string; code: string };
    expect(err.code).toBe('BODY_INVALID');
    expect(err.message).toContain('forge-review@verdict');
    expect(err.message).toContain('approve|request-changes|abstain');
  });
});
