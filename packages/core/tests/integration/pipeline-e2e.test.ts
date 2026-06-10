import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.3-F6 pipeline E2E.
//
// Exercises the bus → subscribers → activity_log path against real Postgres,
// plus the search endpoint's filter combinators (status, q, label EXISTS
// subquery). Uses dynamic imports inside beforeAll so that
// `process.env.DATABASE_URL` is set to the harness URL BEFORE any src module
// loads `config/env.ts` and binds `db/client.ts` to a different URL —
// otherwise subscribers would write to the wrong database/schema.

type PipelineMods = {
  HooksBus: typeof import('../../src/pipeline/hooks.js').HooksBus;
  // biome-ignore format: esbuild's TS transform cannot parse a line break inside import(); keep on one line
  registerActivitySubscribers: typeof import('../../src/pipeline/subscribers.js').registerActivitySubscribers;
  searchRoutes: typeof import('../../src/issues/search.js').searchRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
  canTransition: typeof import('../../src/pipeline/state-machine.js').canTransition;
};

describe('F6 pipeline E2E', () => {
  let harness: TestDatabase;
  let mods: PipelineMods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount mixing BlankEnv with AuthVars routes
  let app: any;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    // MUST set DATABASE_URL (with the harness's search_path pin) BEFORE any
    // src import loads env.ts, or the app's db client binds to the base URL
    // and writes land in the wrong schema.
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

    const [hooksMod, subsMod, searchMod, jwtMod, errMod, smMod] = await Promise.all([
      import('../../src/pipeline/hooks.js'),
      import('../../src/pipeline/subscribers.js'),
      import('../../src/issues/search.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
      import('../../src/pipeline/state-machine.js'),
    ]);

    mods = {
      HooksBus: hooksMod.HooksBus,
      registerActivitySubscribers: subsMod.registerActivitySubscribers,
      searchRoutes: searchMod.searchRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
      canTransition: smMod.canTransition,
    };

    app = new Hono();
    app.route('/api/projects', mods.searchRoutes);
    app.onError(mods.errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed(opts: { verified?: boolean } = {}) {
    const user = await createTestUser(harness.db);
    if (opts.verified !== false) {
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
      );
    }
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    return { user, project };
  }

  async function insertIssue(
    projectId: string,
    createdById: string,
    overrides: {
      status?: string;
      reopenCount?: number;
      title?: string;
      description?: string | null;
      priority?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, description, status, priority, reopen_count, created_by_id, iss_seq)
      VALUES (
        ${id},
        ${projectId},
        ${overrides.title ?? 'integration issue'},
        ${overrides.description ?? null},
        ${overrides.status ?? 'open'},
        ${overrides.priority ?? 'medium'},
        ${overrides.reopenCount ?? 0},
        ${createdById},
        ${Math.floor(Math.random() * 1_000_000)}
      )
    `);
    return id;
  }

  async function insertLabel(projectId: string, name: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO labels (id, project_id, name, color)
      VALUES (${id}, ${projectId}, ${name}, '#ff0000')
    `);
    return id;
  }

  async function attachLabel(issueId: string, labelId: string): Promise<void> {
    await harness.db.execute(
      sql`INSERT INTO issue_labels (issue_id, label_id) VALUES (${issueId}, ${labelId})`,
    );
  }

  async function activityRows(
    issueId: string,
  ): Promise<Array<{ action: string; payload: unknown }>> {
    const rows = await harness.db.execute<{ action: string; payload: unknown }>(sql`
      SELECT action, payload FROM activity_log
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `);
    return rows as Array<{ action: string; payload: unknown }>;
  }

  describe('bus → activity_log', () => {
    it('issueCreated subscriber writes the canonical issue.created row', async () => {
      const { user, project } = await seed();
      const issueId = await insertIssue(project.id, user.id);

      const bus = new mods.HooksBus();
      mods.registerActivitySubscribers(bus);
      await bus.emit('issueCreated', {
        issueId,
        projectId: project.id,
        actor: { type: 'user', id: user.id },
        snapshot: {
          title: 't',
          description: null,
          priority: 'high',
          category: null,
          assigneeId: null,
          labels: [],
        },
      });

      const rows = await activityRows(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe('issue.created');
    });

    it('transition subscriber fires per status change', async () => {
      const { user, project } = await seed();
      const issueId = await insertIssue(project.id, user.id);

      const bus = new mods.HooksBus();
      mods.registerActivitySubscribers(bus);

      const steps = ['open→confirmed', 'confirmed→clarified', 'clarified→approved'] as const;
      for (const step of steps) {
        const [from, to] = step.split('→') as [
          Parameters<typeof mods.canTransition>[0],
          Parameters<typeof mods.canTransition>[1],
        ];
        expect(mods.canTransition(from, to)).toBe(true);
        await bus.emit('transition', {
          issueId,
          projectId: project.id,
          actor: { type: 'user', id: user.id },
          from,
          to,
          reopenCount: 0,
        });
      }

      const rows = await activityRows(issueId);
      expect(rows).toHaveLength(steps.length);
      for (const r of rows) expect(r.action).toBe('issue.statusChanged');
    });

    it('comment subscribers fire for create/update/delete', async () => {
      const { user, project } = await seed();
      const issueId = await insertIssue(project.id, user.id);
      const commentId = randomUUID();
      const bus = new mods.HooksBus();
      mods.registerActivitySubscribers(bus);

      const common = {
        issueId,
        projectId: project.id,
        actor: { type: 'user' as const, id: user.id },
        commentId,
      };
      await bus.emit('commentCreated', { ...common, body: 'hello' });
      await bus.emit('commentUpdated', { ...common, before: 'hello', after: 'hi' });
      await bus.emit('commentDeleted', common);

      const rows = await activityRows(issueId);
      expect(rows.map((r) => r.action)).toEqual([
        'comment.created',
        'comment.updated',
        'comment.deleted',
      ]);
    });

    it('FK cascade: deleting the issue removes its activity rows', async () => {
      const { user, project } = await seed();
      const issueId = await insertIssue(project.id, user.id);
      const bus = new mods.HooksBus();
      mods.registerActivitySubscribers(bus);

      await bus.emit('issueCreated', {
        issueId,
        projectId: project.id,
        actor: { type: 'user', id: user.id },
        snapshot: {
          title: 't',
          description: null,
          priority: 'medium',
          category: null,
          assigneeId: null,
          labels: [],
        },
      });
      expect((await activityRows(issueId)).length).toBe(1);

      await harness.db.execute(sql`DELETE FROM issues WHERE id = ${issueId}`);
      expect((await activityRows(issueId)).length).toBe(0);
    });
  });

  describe('GET /api/projects/:id/issues/search', () => {
    async function authedGet(path: string, userId: string): Promise<Response> {
      const tok = await mods.signUserToken(userId);
      return app.request(path, { headers: { authorization: `Bearer ${tok}` } });
    }

    it('q filter: ILIKE matches title and description', async () => {
      const { user, project } = await seed();
      await insertIssue(project.id, user.id, { title: 'Login bug', description: 'broken' });
      await insertIssue(project.id, user.id, { title: 'Checkout crash', description: null });
      await insertIssue(project.id, user.id, { title: 'Typo', description: 'login flow' });

      const res = await authedGet(`/api/projects/${project.id}/issues/search?q=login`, user.id);
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ title: string }>;
      expect(list.length).toBe(2);
    });

    it('q filter: escapes ILIKE metachars in user input', async () => {
      const { user, project } = await seed();
      await insertIssue(project.id, user.id, { title: '100% done', description: null });
      await insertIssue(project.id, user.id, { title: '50 percent', description: null });

      // Without escaping, `%` would be a wildcard and both rows would match.
      const res = await authedGet(
        `/api/projects/${project.id}/issues/search?q=${encodeURIComponent('100%')}`,
        user.id,
      );
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ title: string }>;
      expect(list.length).toBe(1);
      expect(list[0]?.title).toBe('100% done');
    });

    it('status filter (multi): IN combinator', async () => {
      const { user, project } = await seed();
      await insertIssue(project.id, user.id, { title: 'a', status: 'open' });
      await insertIssue(project.id, user.id, { title: 'b', status: 'confirmed' });
      await insertIssue(project.id, user.id, { title: 'c', status: 'closed' });

      const res = await authedGet(
        `/api/projects/${project.id}/issues/search?status=open&status=confirmed`,
        user.id,
      );
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ status: string }>;
      expect(list.length).toBe(2);
      expect(list.map((i) => i.status).sort()).toEqual(['confirmed', 'open']);
    });

    it('label filter (any-of): EXISTS subquery against issue_labels', async () => {
      const { user, project } = await seed();
      const bugLabel = await insertLabel(project.id, 'bug');
      const otherLabel = await insertLabel(project.id, 'docs');

      const a = await insertIssue(project.id, user.id, { title: 'A' });
      const b = await insertIssue(project.id, user.id, { title: 'B' });
      await insertIssue(project.id, user.id, { title: 'C' });
      await attachLabel(a, bugLabel);
      await attachLabel(b, otherLabel);
      // C has no labels

      const res = await authedGet(
        `/api/projects/${project.id}/issues/search?label=${bugLabel}`,
        user.id,
      );
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ title: string }>;
      expect(list.length).toBe(1);
      expect(list[0]?.title).toBe('A');

      // Any-of: both bug and docs → A + B, not C
      const res2 = await authedGet(
        `/api/projects/${project.id}/issues/search?label=${bugLabel}&label=${otherLabel}`,
        user.id,
      );
      const list2 = (await res2.json()) as Array<{ title: string }>;
      expect(list2.length).toBe(2);
      expect(list2.map((i) => i.title).sort()).toEqual(['A', 'B']);
    });

    it('combines q + status + label filters', async () => {
      const { user, project } = await seed();
      const bugLabel = await insertLabel(project.id, 'bug');
      const match = await insertIssue(project.id, user.id, {
        title: 'Login bug',
        status: 'open',
      });
      await attachLabel(match, bugLabel);
      const other = await insertIssue(project.id, user.id, {
        title: 'Login bug two',
        status: 'closed',
      });
      await attachLabel(other, bugLabel);

      const res = await authedGet(
        `/api/projects/${project.id}/issues/search?q=login&status=open&label=${bugLabel}`,
        user.id,
      );
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<{ title: string }>;
      expect(list.length).toBe(1);
      expect(list[0]?.title).toBe('Login bug');
    });

    it('X-Total-Count header reflects the filtered count', async () => {
      const { user, project } = await seed();
      for (let i = 0; i < 5; i++) {
        await insertIssue(project.id, user.id, { title: `issue ${i}`, status: 'open' });
      }
      const res = await authedGet(
        `/api/projects/${project.id}/issues/search?status=open&limit=2`,
        user.id,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Total-Count')).toBe('5');
      const list = (await res.json()) as Array<unknown>;
      expect(list.length).toBe(2);
    });

    it('403 when caller is not a project member', async () => {
      const { project } = await seed();
      const stranger = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
      );

      const res = await authedGet(`/api/projects/${project.id}/issues/search`, stranger.id);
      expect(res.status).toBe(403);
    });
  });
});
