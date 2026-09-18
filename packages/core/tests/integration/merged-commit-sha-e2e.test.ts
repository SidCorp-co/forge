/**
 * ISS-959 B, ISS-1073 — what a merged mark records, and what it no longer can.
 *
 * Against a real Postgres because every statement here is about a PREDICATE,
 * and a predicate is the one thing a mocked drizzle chain cannot answer for.
 *
 * ## What ISS-1073 moved, and why these cases were rewritten rather than deleted
 *
 * `merged_commit_sha` was the commit a CALLER named. It is now evidence: the
 * only thing that writes one is a merge Forge watched happen — its own
 * `PUT .../merge`, or GitHub's `pull_request` event carrying `merged`. So the
 * cases that asserted a caller's sha landing in the column now assert that it
 * does not, and that the mark says so rather than dropping it quietly; the
 * caller's sha is in the audit comment, which is where a reader can still find
 * it.
 *
 * What that buys is the pair of predicates below. An assertion writes under
 * `merged_at IS NULL`, so the first stamp wins and a second mark changes
 * nothing. Evidence writes under `merged_commit_sha IS NULL`, so a merge Forge
 * later observes REPLACES a stamp somebody asserted and takes the merge's own
 * time — which is the repair for the thing ISS-1027's retraction measured, where
 * `unmark` then `mark` re-stamped the correction's time and no further
 * correcting recovered the landing's. Evidence already recorded is never
 * replaced, which is what makes one merge arriving by both routes one record.
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

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

// cm:guard the helpers below live at module scope rather than inside the describe, and the reason is
// `check-size-budget.mjs`: a describe callback is a function, so every helper written inside it
// counts against the 150-line budget for one. Hoisting them keeps the budget measuring the cases.
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
  const row = rows[0] as { merged_at: Date | string | null; merged_commit_sha: string | null };
  // cm:guard `execute` hands back the driver's own value, which is a STRING for timestamptz, so a
  // caller that assumed a Date here read `.toISOString is not a function` rather than a wrong
  // timestamp. Normalising once is what lets every case below assert on an exact instant.
  return {
    merged_at: row.merged_at === null ? null : new Date(row.merged_at),
    merged_commit_sha: row.merged_commit_sha,
  };
}

async function commentsOn(id: string) {
  const rows = await harness.db.execute<{ body: string }>(
    sql`SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at`,
  );
  return rows.map((r) => (r as { body: string }).body);
}

/** A pull request Forge watched merge, on this issue, as the projection holds it. */
async function seedObservedMerge(
  issueId: string,
  args: { commit: string; at: string; number?: number },
) {
  const rows = await harness.db.execute<{ project_id: string }>(
    sql`SELECT project_id FROM issues WHERE id = ${issueId}`,
  );
  const projectId = (rows[0] as { project_id: string }).project_id;
  const owner = await harness.db.execute<{ created_by_id: string }>(
    sql`SELECT created_by_id FROM issues WHERE id = ${issueId}`,
  );
  const conn = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_connections (owner_type, owner_id, provider, display_name)
    VALUES ('user', ${(owner[0] as { created_by_id: string }).created_by_id}, 'github', 'gh')
    RETURNING id
  `);
  const binding = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO integration_bindings (project_id, connection_id, provider, role, config)
    VALUES (${projectId}, ${(conn[0] as { id: string }).id}, 'github', 'service', '{}'::jsonb)
    RETURNING id
  `);
  await harness.db.execute(sql`
    INSERT INTO repo_pull_requests
      (project_id, binding_id, issue_id, number, repo_full_name, title, state,
       head_ref, head_sha, base_ref, base_sha, merged_at, merge_commit_sha)
    VALUES (${projectId}, ${(binding[0] as { id: string }).id}, ${issueId},
            ${args.number ?? 481}, 'SidCorp-co/forge', 'pr', 'merged',
            'ISS-1-x', 'headsha', 'main', 'basesha', ${args.at}::timestamptz, ${args.commit})
  `);
}

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

// cm:guard this is the planted violation for criterion 9, and it asserts on BOTH halves. Restore
// the caller's sha to the column and the first expectation goes red; keep it out of the column and
// drop the sentence saying so and the second does — which is the shape CLAUDE.md prices, a write
// that quietly declines half of what it was given.

// cm:guard the harness hooks are at MODULE scope and not inside the first describe. They were, and
// splitting this file into two describes for the size budget then ran the first one's `afterAll`
// before the second one's cases, which closed the connection under them — seven tests failing with
// `CONNECTION_ENDED` and nothing wrong with the subject.
describe('ISS-959 B — the merged mark records its commit', () => {
  it('records a caller-named commit in the audit trail and not in the column', async () => {
    const { id, token } = await seed();
    const res = await mark(id, token, { target: 'base', commit: SHA });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe('merged');
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBeNull();
    expect(row.merged_at).not.toBeNull();
    const said = (await commentsOn(id)).join('\n');
    expect(said).toContain(SHA);
    expect(said).toContain("recorded here as this call's claim");
  });

  it('adopts the commit and the time of a merge Forge observed', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    expect((await mark(id, token, { target: 'base' })).status).toBe(200);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBe(SHA);
    expect(row.merged_at?.toISOString()).toBe('2026-09-17T12:17:12.321Z');
  });

  // cm:guard ISS-1027's own defect, measured rather than described: a mark made at 14:43 for a merge
  // that happened at 12:17 used to stamp 14:43, and the CLI says the first stamp wins so no further
  // correcting recovered it. The observed time outranking the caller's is what closes that.
  it('prefers the observed merge time over a time the caller supplied', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, {
      target: 'base',
      commit: SHA,
      mergedAt: '2026-09-17T14:43:00.000Z',
    });
    expect((await storedMark(id)).merged_at?.toISOString()).toBe('2026-09-17T12:17:12.321Z');
  });

  it('says so when the caller named a different commit from the one Forge observed', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, { target: 'base', commit: 'feedface1234567' });
    const said = (await commentsOn(id)).join('\n');
    expect(said).toContain('feedface1234567');
    expect(said).toContain(`which for this issue is ${SHA}`);
    expect((await storedMark(id)).merged_commit_sha).toBe(SHA);
  });

  // cm:guard criteria 14 and 15. The assertion's predicate is `merged_at IS NULL` and evidence's is
  // `merged_commit_sha IS NULL`, and this is the case that can only pass if they differ: an issue
  // marked by hand, then merged for real, ends up carrying the real merge and the real time.
  it('lets evidence replace an asserted stamp, taking the merge own time', async () => {
    const { id, token } = await seed();
    await mark(id, token, { target: 'base', mergedAt: '2026-09-17T14:43:00.000Z' });
    expect((await storedMark(id)).merged_commit_sha).toBeNull();

    const { recordIssueMerge } = await import('../../src/issues/merge-record.js');
    const observed = await recordIssueMerge(harness.db as never, {
      issueId: id,
      evidence: {
        kind: 'observed',
        commitSha: SHA,
        mergedAt: new Date('2026-09-17T12:17:12.321Z'),
        via: 'event',
      },
    });
    expect(observed.wrote).toBe(true);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBe(SHA);
    expect(row.merged_at?.toISOString()).toBe('2026-09-17T12:17:12.321Z');
  });

  // cm:guard criteria 11, 12 and 16 in one statement: ONE merge arriving twice, once as the kernel's
  // own and once as the `pull_request.closed` delivery that follows it. The second write finds
  // `merged_commit_sha` already set, changes nothing, and reports that it wrote nothing — which is
  // what makes the two routes one record rather than two.
  it('leaves one record when the same merge arrives from both routes', async () => {
    const { id } = await seed();
    const { recordIssueMerge } = await import('../../src/issues/merge-record.js');
    const first = await recordIssueMerge(harness.db as never, {
      issueId: id,
      evidence: {
        kind: 'observed',
        commitSha: SHA,
        mergedAt: new Date('2026-09-17T12:17:12.321Z'),
        via: 'kernel',
      },
    });
    const second = await recordIssueMerge(harness.db as never, {
      issueId: id,
      evidence: {
        kind: 'observed',
        commitSha: 'feedface1234567',
        mergedAt: new Date('2026-09-17T12:17:30.000Z'),
        via: 'event',
      },
    });
    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBe(SHA);
    expect(row.merged_at?.toISOString()).toBe('2026-09-17T12:17:12.321Z');
  });
});

/**
 * The shape rules and the correction route, which ISS-1073 left standing.
 *
 * A second describe rather than a longer one: `check-size-budget.mjs` measures the callback, and a
 * suite that grows past it by adding cases is one that stops being split by subject and starts being
 * split by nothing.
 */
describe('ISS-959 B — what the mark still refuses, and how a mark is corrected', () => {
  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('AC12 — GET /api/issues/:id returns the stored sha', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, { target: 'base' });
    const res = await app.request(`/api/issues/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).mergedCommitSha).toBe(SHA);
  });

  it('AC13 — a second mark on an already-marked issue leaves the stored sha unchanged', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, { target: 'base' });
    const second = await mark(id, token, { target: 'base', commit: 'feedface1234567' });
    expect(second.status).toBe(200);
    expect((await second.json()).action).toBe('already_merged');
    expect((await storedMark(id)).merged_commit_sha).toBe(SHA);
  });

  it('AC14 — unmark clears the stored sha, together with the timestamp', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, { target: 'base' });
    const res = await unmark(id, token);
    expect(res.status).toBe(200);
    const row = await storedMark(id);
    expect(row.merged_commit_sha).toBeNull();
    expect(row.merged_at).toBeNull();
  });

  it('AC16 — a mark on an issue with no recorded handoff sha stores no sha', async () => {
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

  // cm:guard the SHAPE check survives ISS-1073 untouched and is asserted on the audit trail now that
  // the column is evidence. The schema still refuses prose in a commit field, and it has to: a
  // caller's claim is recorded, and a recorded claim reading `squashed as abc123` is the judgement
  // the field was built to stop, wherever it is written down.
  it('accepts a short sha at the lower bound and refuses one below it', async () => {
    const short = await seed();
    expect((await mark(short.id, short.token, { target: 'base', commit: 'abc1234' })).status).toBe(
      200,
    );
    expect((await commentsOn(short.id)).join('\n')).toContain('abc1234');

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

  // cm:guard `unmark` then `mark` is still the only route that moves an asserted stamp, and after
  // ISS-1073 it is no longer the only route that fixes a WRONG one: evidence supersedes an assertion
  // without it. This asserts the first half stays true, so a reader is not left thinking the
  // correction route went away with the column.
  it('re-marking after an unmark re-adopts whatever Forge now observes', async () => {
    const { id, token } = await seed();
    await seedObservedMerge(id, { commit: SHA, at: '2026-09-17T12:17:12.321Z' });
    await mark(id, token, { target: 'base' });
    await unmark(id, token);
    expect((await storedMark(id)).merged_commit_sha).toBeNull();
    await mark(id, token, { target: 'base' });
    expect((await storedMark(id)).merged_commit_sha).toBe(SHA);
  });
});
