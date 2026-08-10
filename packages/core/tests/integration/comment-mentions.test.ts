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

// Integration coverage for ISS-276 PR-B — comment mentions + notification fan-out.
//
// Exercises POST /api/issues/:id/comments end-to-end against real Postgres:
// parses @handle, inserts comment_mentions rows, and the notify-mentions
// subscriber writes a notifications row per mentioned user (excluding actor
// and unknown handles).

type Mods = {
  issueRoutes: typeof import('../../src/issues/routes.js').issueRoutes;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  errorHandler: typeof import('../../src/middleware/error.js').errorHandler;
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
  registerNotifyMentionsSubscriber: typeof import('../../src/notifications/notify-mentions.js').registerNotifyMentionsSubscriber;
};

describe('ISS-276 comment mentions', () => {
  let harness: TestDatabase;
  let mods: Mods;
  // biome-ignore lint/suspicious/noExplicitAny: test-only mount
  let app: any;

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

    const [issuesMod, jwtMod, errMod, hooksMod, notifyMod] = await Promise.all([
      import('../../src/issues/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
      import('../../src/pipeline/hooks.js'),
      import('../../src/notifications/notify-mentions.js'),
    ]);

    mods = {
      issueRoutes: issuesMod.issueRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
      hooks: hooksMod.hooks,
      registerNotifyMentionsSubscriber: notifyMod.registerNotifyMentionsSubscriber,
    };

    // The bus is module-singleton; src/index.ts is not imported in this
    // test, so we must register the subscriber explicitly. Reset first to
    // avoid bleed from any earlier suite that registered handlers.
    mods.hooks.reset();
    mods.registerNotifyMentionsSubscriber(mods.hooks);

    app = new Hono();
    app.route('/api/issues', mods.issueRoutes);
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
    const alice = await createTestUser(harness.db, { email: 'alice@test.local' });
    const bob = await createTestUser(harness.db, { email: 'bob@test.local' });
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id IN (${owner.id}, ${alice.id}, ${bob.id})`,
    );

    const project = await createTestProject(harness.db, owner.id);
    for (const u of [owner, alice, bob]) {
      await createTestProjectMember(harness.db, {
        userId: u.id,
        projectId: project.id,
        role: u.id === owner.id ? 'admin' : 'member',
      });
    }
    const issueRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'mention-target', ${owner.id})
      RETURNING id
    `);
    const issueId = (issueRows[0] as { id: string }).id;
    return { owner, alice, bob, project, issueId };
  }

  async function postComment(issueId: string, jwt: string, body: string) {
    return app.request(`/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  it('inserts comment_mentions + notification rows for resolved handles', async () => {
    const { owner, alice, bob, issueId } = await seed();
    const jwt = await mods.signUserToken(owner.id);

    const res = await postComment(issueId, jwt, 'Hey @alice and @bob — please review');
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const mentionRows = await harness.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM comment_mentions WHERE comment_id = ${created.id} ORDER BY user_id`,
    );
    const mentionedUserIds = mentionRows.map((r) => (r as { user_id: string }).user_id).sort();
    expect(mentionedUserIds).toEqual([alice.id, bob.id].sort());

    const notifRows = await harness.db.execute<{ user_id: string; type: string }>(
      sql`SELECT user_id, type FROM notifications WHERE issue_id = ${issueId} ORDER BY user_id`,
    );
    expect(notifRows.length).toBe(2);
    for (const r of notifRows) {
      expect((r as { type: string }).type).toBe('mention');
    }
  });

  it('skips self-mention and unknown handles', async () => {
    const { owner, alice, issueId } = await seed();
    const jwt = await mods.signUserToken(owner.id);

    const res = await postComment(
      issueId,
      jwt,
      '@owner self-mention, @alice valid, @ghost unknown',
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const mentionRows = await harness.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM comment_mentions WHERE comment_id = ${created.id}`,
    );
    expect(mentionRows.length).toBe(1);
    expect((mentionRows[0] as { user_id: string }).user_id).toBe(alice.id);

    const notifRows = await harness.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM notifications WHERE issue_id = ${issueId}`,
    );
    expect(notifRows.length).toBe(1);
    expect((notifRows[0] as { user_id: string }).user_id).toBe(alice.id);
  });

  it('writes nothing when the comment has no mentions', async () => {
    const { owner, issueId } = await seed();
    const jwt = await mods.signUserToken(owner.id);

    const res = await postComment(issueId, jwt, 'plain comment, no handles');
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const mentionRows = await harness.db.execute(
      sql`SELECT 1 FROM comment_mentions WHERE comment_id = ${created.id}`,
    );
    expect(mentionRows.length).toBe(0);
    const notifRows = await harness.db.execute(
      sql`SELECT 1 FROM notifications WHERE issue_id = ${issueId}`,
    );
    expect(notifRows.length).toBe(0);
  });
});
