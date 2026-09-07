/**
 * ISS-959 B — the merged mark records the commit it was made at.
 *
 * Against a real Postgres because the answerable half is the conditional
 * write: the sha lands under the SAME `WHERE merged_at IS NULL` as the
 * timestamp, so the commit on the row always belongs to the call that actually
 * stamped it. A repeat mark that keeps the first sha, and an `unmark` that
 * clears both columns together, are statements about that predicate.
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

type Mods = {
  issueMergeRoutes: typeof import('../../src/issues/merge-routes.js')['issueMergeRoutes'];
  issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('ISS-959 B — the merged mark records its commit', () => {
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

    const [mergeMod, routesMod, jwtMod, errMod] = await Promise.all([
      import('../../src/issues/merge-routes.js'),
      import('../../src/issues/routes.js'),
      import('../../src/auth/jwt.js'),
      import('../../src/middleware/error.js'),
    ]);
    mods = {
      issueMergeRoutes: mergeMod.issueMergeRoutes,
      issueRoutes: routesMod.issueRoutes,
      signUserToken: jwtMod.signUserToken,
      errorHandler: errMod.errorHandler,
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

  async function seed(handoffCommit?: string | null) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${project.id}, ${Math.floor(Math.random() * 1_000_000)}, 'mark', 'in_progress',
              ${user.id})
    `);
    if (handoffCommit !== undefined) {
      const runs = await harness.db.execute<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, issue_id, status)
        VALUES (${project.id}, ${id}, 'running') RETURNING id
      `);
      const runId = (runs[0] as { id: string }).id;
      const payload = handoffCommit
        ? { commitSha: handoffCommit, outcome: 'ok' }
        : { outcome: 'ok', summary: 'no code' };
      await harness.db.execute(sql`
        INSERT INTO issue_step_contexts (project_id, issue_id, pipeline_run_id, kind, step, payload)
        VALUES (${project.id}, ${id}, ${runId}, 'handoff', 'drive', ${JSON.stringify(payload)}::jsonb)
      `);
    }
    const token = await mods.signUserToken(user.id);
    return { id, token };
  }

  function mark(id: string, token: string, body: unknown) {
    return app.request(`/api/issues/${id}/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function unmark(id: string, token: string) {
    return app.request(`/api/issues/${id}/merge`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
  }

  async function storedMark(id: string) {
    const rows = await harness.db.execute<{
      merged_at: Date | null;
      merged_commit_sha: string | null;
    }>(sql`SELECT merged_at, merged_commit_sha FROM issues WHERE id = ${id}`);
    return rows[0] as { merged_at: Date | null; merged_commit_sha: string | null };
  }

  it('AC11 — a mark carrying `commit` stores that sha on the issue', async () => {
    const { id, token } = await seed();
    const res = await mark(id, token, { target: 'base', commit: SHA });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('merged');
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBe(SHA);
    expect(row.merged_at).not.toBeNull();
  });

  it('AC12 — GET /api/issues/:id returns the stored sha', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', commit: SHA });
    const res = await app.request(`/api/issues/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mergedCommitSha).toBe(SHA);
  });

  it('AC13 — a second mark on an already-marked issue leaves the stored sha unchanged', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', commit: SHA });
    const second = await mark(id, token, { target: 'base', commit: 'feedface1234567' });
    expect(second.status).toBe(200);
    expect((await second.json()).action).toBe('already_merged');
    expect((await storedMark(id)).merged_commit_sha).toBe(SHA);
  });

  it('AC14 — unmark clears the stored sha, together with the timestamp', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', commit: SHA });
    const res = await unmark(id, token);
    expect(res.status).toBe(200);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBeNull();
    expect(row.merged_at).toBeNull();
  });

  it('AC15 — a mark sending no `commit` stores the sha recorded on the implementation handoff', async () => {
    const { id, token } = await seed('0f1e2d3c4b5a69788796a5b4c3d2e1f001234567');
    const res = await mark(id, token, { target: 'base' });
    expect(res.status).toBe(200);
    expect((await storedMark(id)).merged_commit_sha).toBe(
      '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567',
    );
  });

  it('AC16 — a mark sending no `commit` on an issue with no recorded handoff sha stores no sha', async () => {
    const { id, token } = await seed(null);
    const res = await mark(id, token, { target: 'base' });
    expect(res.status).toBe(200);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBeNull();
    expect(row.merged_at).not.toBeNull();
  });

  it('AC17 — a `commit` past the accepted bound is refused 400, and nothing is stamped', async () => {
    const { id, token } = await seed();
    const res = await mark(id, token, { target: 'base', commit: 'f'.repeat(65) });
    expect(res.status).toBe(400);
    const row = await storedMark(id);
    expect(row.merged_at).toBeNull();
    expect(row.merged_commit_sha).toBeNull();
  });

  it('refuses prose in the commit field — a note-shaped value reads as a sha to every consumer and is not one', async () => {
    const { id, token } = await seed();
    const res = await mark(id, token, { target: 'base', commit: 'squashed as abc1234' });
    expect(res.status).toBe(400);
    expect((await storedMark(id)).merged_at).toBeNull();
  });

  it('accepts a short sha at the lower bound and refuses one below it', async () => {
    const short = await seed();
    expect((await mark(short.id, short.token, { target: 'base', commit: 'abc1234' })).status).toBe(
      200,
    );
    expect((await storedMark(short.id)).merged_commit_sha).toBe('abc1234');

    const tooShort = await seed();
    expect(
      (await mark(tooShort.id, tooShort.token, { target: 'base', commit: 'abc123' })).status,
    ).toBe(400);
  });

  it('names the commit in the audit comment the mark writes', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', commit: SHA });
    const rows = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${id}`,
    );
    expect((rows[0] as { body: string }).body).toContain(`commit=${SHA}`);
  });

  it('re-marking after an unmark stores the NEW commit — the only correction route there is', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', commit: SHA });
    await unmark(id, token);
    await mark(id, token, { target: 'base', commit: 'feedface1234567' });
    expect((await storedMark(id)).merged_commit_sha).toBe('feedface1234567');
  });
});
