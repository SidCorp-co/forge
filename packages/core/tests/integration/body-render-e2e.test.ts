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

const HTML_BODY = '<blockquote><p>ran the suite</p></blockquote><p>tidy <code>a.ts</code></p>';

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

  it('hands the detail payload a tree for a description written as html', async () => {
    const { issueId, jwt } = await seed();
    const patch = await app.request(`/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: auth(jwt),
      body: JSON.stringify({ description: HTML_BODY, descriptionFormat: 'html' }),
    });
    expect(patch.status).toBe(200);

    const res = await app.request(`/api/issues/${issueId}`, { headers: auth(jwt) });
    const detail = (await res.json()) as {
      descriptionFormat: string;
      descriptionNodes: BodyNodeish[] | null;
    };
    expect(detail.descriptionFormat).toBe('html');
    expect(detail.descriptionNodes?.[0]).toMatchObject({
      type: 'element',
      name: 'blockquote',
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
      body: JSON.stringify({ body: HTML_BODY, format: 'html' }),
    });
    expect(posted.status).toBe(201);

    const res = await app.request(`/api/issues/${issueId}/comments`, { headers: auth(jwt) });
    const page = (await res.json()) as {
      items: { format: string; nodes: BodyNodeish[] | null }[];
    };
    expect(page.items[0]?.format).toBe('html');
    expect(page.items[0]?.nodes?.[0]).toMatchObject({ name: 'blockquote' });
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
      body: JSON.stringify({ raw: HTML_BODY, format: 'html' }),
    });
    const rendered = (await html.json()) as { nodes: BodyNodeish[] };
    expect(rendered.nodes[0]).toMatchObject({ name: 'blockquote' });
  });

  it('refuses component markup in the preview with the same named 400 the save gives', async () => {
    const { jwt } = await seed();
    const res = await app.request('/api/body/preview', {
      method: 'POST',
      headers: auth(jwt),
      body: JSON.stringify({ raw: '<forge-review sha="60e8d635" verdict="maybe"></forge-review>' }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { message: string; code: string };
    expect(err.code).toBe('BODY_INVALID');
    expect(err.message).toContain('forge-review');
    expect(err.message).toContain('removed on 2026-09-14');
  });
});
