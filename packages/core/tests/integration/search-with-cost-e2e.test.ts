/**
 * ISS-1081 — `?withCost=1` on the issues search endpoint, against a real
 * Postgres.
 *
 * The sibling unit suite (`src/issues/search.test.ts`) stubs the database, so a
 * statement Postgres cannot even parse passes it. That is how ISS-1015 shipped
 * a rollup whose join predicate emitted a bare `session_id` that resolves in
 * two tables at once, and how the Issues list went down on every non-empty
 * project while every gate stayed green. Only a real Postgres can answer
 * whether the statement drizzle emits is a statement the server accepts, so
 * every case here goes through the mounted router to a live database.
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
  searchRoutes: typeof import('../../src/issues/search.js')['searchRoutes'];
  issueCostRollupQuery: typeof import('../../src/issues/search.js')['issueCostRollupQuery'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let user: { id: string };
let project: { id: string };
let token: string;

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

  const [searchMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/search.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    searchRoutes: searchMod.searchRoutes,
    issueCostRollupQuery: searchMod.issueCostRollupQuery,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
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
  user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  token = await mods.signUserToken(user.id);
});

type Row = { id: string; title: string; estimatedCost?: number };

let seq = 0;
async function insertIssue(title: string, projectId = project.id): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${title}, 'open', ${user.id})
  `);
  return id;
}

/** One agent session, and one job of `issueId` that ran under it. */
async function insertJobWithSession(issueId: string, sessionId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, status, started_at)
    VALUES (${sessionId}, ${project.id}, 'idle', now())
    ON CONFLICT (id) DO NOTHING
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, created_by, type, status, agent_session_id)
    VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${user.id}, 'plan', 'done', ${sessionId})
  `);
}

/**
 * A usage row against `sessionId`. `usage_records.session_id` is TEXT holding a
 * canonical lowercase uuid (the CHECK ISS-1015 added), so it is written as the
 * text the column is constrained to rather than as a uuid.
 */
async function insertUsage(sessionId: string, cost: number): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO usage_records (id, project_id, source, model, input_tokens, output_tokens,
                               estimated_cost, request_count, session_id, recorded_at)
    VALUES (${randomUUID()}, ${project.id}, 'cli', 'claude-opus-4-7', 100, 10,
            ${cost}, 1, ${sessionId}, now())
  `);
}

const search = async (qs: string, projectId = project.id): Promise<Row[]> => {
  const res = await app.request(`/api/projects/${projectId}/issues/search${qs}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  expect(res.status, `GET /issues/search${qs}`).toBe(200);
  return ((await res.json()) as { items: Row[] }).items;
};

const byTitle = (rows: Row[], title: string): Row => {
  const row = rows.find((r) => r.title === title);
  if (!row) throw new Error(`no row titled ${title}`);
  return row;
};

describe('ISS-1081 · search ?withCost against a real database', () => {
  // criterion 1 — the whole defect in one line. Before the fix this is a 500,
  // because Postgres refuses the statement with `column reference "session_id"
  // is ambiguous`; the mocked suite cannot represent that failure at all.
  it('answers 200 under withCost=1 on a project that holds an issue', async () => {
    const issue = await insertIssue('priced');
    const session = randomUUID();
    await insertJobWithSession(issue, session);
    await insertUsage(session, 0.25);

    const rows = await search('?withCost=1');
    expect(rows.map((r) => r.title)).toEqual(['priced']);
  });

  // criterion 2 — the sum is over the issue's DISTINCT sessions, so two
  // sessions on one issue add up rather than one of them winning.
  it('sums the cost of every session that worked the issue', async () => {
    const issue = await insertIssue('two-sessions');
    const a = randomUUID();
    const b = randomUUID();
    await insertJobWithSession(issue, a);
    await insertJobWithSession(issue, b);
    await insertUsage(a, 0.25);
    await insertUsage(b, 0.5);
    await insertUsage(b, 0.25);

    expect(byTitle(await search('?withCost=1'), 'two-sessions').estimatedCost).toBeCloseTo(1.0, 6);
  });

  // criterion 3 — the DISTINCT (issue_id, session) pair is what keeps a session
  // that backed several jobs of the same issue from multiplying its own cost.
  // Drop the DISTINCT and this row reads 0.75 instead of 0.25.
  it('counts a session that backed three jobs of one issue exactly once', async () => {
    const issue = await insertIssue('one-session-three-jobs');
    const session = randomUUID();
    await insertJobWithSession(issue, session);
    await insertJobWithSession(issue, session);
    await insertJobWithSession(issue, session);
    await insertUsage(session, 0.25);

    expect(
      byTitle(await search('?withCost=1'), 'one-session-three-jobs').estimatedCost,
    ).toBeCloseTo(0.25, 6);
  });

  // criterion 2, the other half — one issue's sessions do not price another's.
  it('keeps each issue on its own sessions', async () => {
    const mine = await insertIssue('mine');
    const yours = await insertIssue('yours');
    const a = randomUUID();
    const b = randomUUID();
    await insertJobWithSession(mine, a);
    await insertJobWithSession(yours, b);
    await insertUsage(a, 0.25);
    await insertUsage(b, 4.0);

    const rows = await search('?withCost=1');
    expect(byTitle(rows, 'mine').estimatedCost).toBeCloseTo(0.25, 6);
    expect(byTitle(rows, 'yours').estimatedCost).toBeCloseTo(4.0, 6);
  });

  // criterion 9 — the boundary the defect hides behind: an issue whose jobs
  // match no usage row is still a row of the page, carrying a numeric zero
  // rather than a missing key (the ISS-437 guard on search.ts).
  it('returns an issue with no matching usage carrying estimatedCost 0', async () => {
    const issue = await insertIssue('unpriced');
    await insertJobWithSession(issue, randomUUID());

    const row = byTitle(await search('?withCost=1'), 'unpriced');
    expect(row).toHaveProperty('estimatedCost');
    expect(row.estimatedCost).toBe(0);
  });

  it('returns an issue that never ran at all carrying estimatedCost 0', async () => {
    await insertIssue('never-ran');

    const row = byTitle(await search('?withCost=1'), 'never-ran');
    expect(row).toHaveProperty('estimatedCost');
    expect(row.estimatedCost).toBe(0);
  });

  // criterion 8 — the five projects that answered 200 on beta were exactly the
  // empty ones, because `serialized.length > 0` skips the rollup entirely. This
  // case is what makes the others' greens mean something: it passes with the
  // defect in place, so a suite holding only this one proves nothing.
  it('answers 200 with an empty page on a project holding no issues', async () => {
    const empty = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: empty.id,
      role: 'admin',
    });
    expect(await search('?withCost=1', empty.id)).toEqual([]);
  });

  // criteria 4 and 5 — read off the statement the route sends, not off a
  // likeness of it. Criterion 4: every `session_id` in the emitted ON clause is
  // qualified, so no reference of that name resolves in two tables at once.
  // Criterion 5: the left side is the uncast `usage_records.session_id`, which
  // is the index-scan property ISS-1015 bought and this fix may not spend.
  it('emits a join whose session reference is qualified and whose left side is uncast', () => {
    const { sql: text } = mods.issueCostRollupQuery([randomUUID(), randomUUID()]).toSQL();
    const on = /inner join "usage_records" on (.+?)(?: group by | where |$)/i.exec(text)?.[1];
    expect(on, `no ON clause found in: ${text}`).toBeDefined();

    // Nothing in the predicate names a column without naming its table.
    expect(on).not.toMatch(/(?<!\.)"session_id"/);
    expect(on).toMatch(/"issue_sessions"\."[a-z_]+"/);
    // And the indexed side is compared as it is stored.
    expect(on).toContain('"usage_records"."session_id" =');
    expect(on).not.toMatch(/"usage_records"\."session_id"::/);
  });

  // The statement above is the one Postgres is asked to run, and a rendering
  // assertion alone would go green on a statement the server still refuses.
  it('runs the emitted statement on Postgres without an ambiguity refusal', async () => {
    const issue = await insertIssue('explained');
    const session = randomUUID();
    await insertJobWithSession(issue, session);
    await insertUsage(session, 0.25);

    await expect(
      harness.db.execute(sql`EXPLAIN (COSTS OFF) ${mods.issueCostRollupQuery([issue]).getSQL()}`),
    ).resolves.toBeDefined();
  });
});
