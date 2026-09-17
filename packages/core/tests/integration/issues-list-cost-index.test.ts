/**
 * ISS-1015 criterion 4, ISS-1081 — the issues-list per-issue cost rollup is
 * planned on the statement the route sends, and no likeness of it.
 *
 * This lived in `usage-session-index.test.ts` until ISS-1081, and the criterion
 * was taken there against a hand-written `INNER JOIN ... ON u.session_id =
 * p.session_id`. That predicate qualified its right-hand side; the statement
 * drizzle emits for `issueCostRollupQuery` did not, so the plan-shape assertion
 * stayed green while every execution of the real query was refused with
 * `column reference "session_id" is ambiguous` and the Issues list answered 500
 * on every non-empty project. What separates this file from that one is only
 * which query it explains.
 */

import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';
import {
  expectIndexServed,
  explain,
  issueId,
  seedFixture,
  seedOwnerProject,
} from './usage-session-ground.js';

// cm:guard `issueCostRollupQuery` is imported AFTER `DATABASE_URL` names the harness, because `src/issues/search.ts` reads `db` off the environment at import. A static import would bind the module to whatever `DATABASE_URL` the shell happened to carry, and the plan below would then be read against a database that is not this fixture.
async function loadRollupQuery(url: string): Promise<(ids: string[]) => { getSQL: () => SQL }> {
  process.env.DATABASE_URL = url;
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
  const { issueCostRollupQuery } = await import('../../src/issues/search.js');
  return issueCostRollupQuery;
}

describe('ISS-1015 criterion 4 · the issues-list cost rollup', () => {
  let harness: TestDatabase;
  let issueCostRollupQuery: (ids: string[]) => { getSQL: () => SQL };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    const owner = await seedOwnerProject(harness.db);
    await seedFixture(harness.db, owner.projectId, owner.userId);
    issueCostRollupQuery = await loadRollupQuery(harness.url);
  }, 600_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const plan = (query: SQL) => explain(harness.db, query);

  // Both widths, because they answer differently and both answers are correct.
  //
  // cm:guard a broad page is NOT asserted to be an index scan, and forcing one would
  // be the wrong fix. One issue resolves about 4 sessions and takes a nested loop over
  // the index; a 25-issue page resolves about 100 (224 on beta, of 15,657), and at that
  // width Postgres legitimately prefers to hash `usage_records` whole rather than probe
  // the index a hundred times. What this change buys the wide case is not an index scan
  // but an uncast join key: measured on beta 2026-09-17 over a real 25-issue page, the
  // same rollup falls from 47.2ms at cost 5,273.81 (Merge Join on `(u.session_id)::uuid`)
  // to 6.2ms at cost 2,709.30. The criterion was written claiming an index scan at both
  // widths; that was wrong about the planner and is corrected on the issue rather than
  // relaxed here to match what got built.
  it('serves the issues-list rollup from the index for one issue', async () => {
    expectIndexServed(await plan(issueCostRollupQuery([issueId(7)]).getSQL()));
  });

  it('joins a 25-issue page on the uncast column, and cheaper than the cast did', async () => {
    const pageIds = Array.from({ length: 25 }, (_, i) => issueId(i + 1));
    const page = sql.join(
      pageIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const costOf = async (query: SQL) => {
      const rows = await harness.db.execute<Record<string, string>>(sql`EXPLAIN ${query}`);
      const text = [...rows].map((r) => Object.values(r)[0]).join('\n');
      return { text, total: Number(/cost=[\d.]+\.\.([\d.]+)/.exec(text)?.[1]) };
    };
    // The `now` side is the statement the route sends. The `before` side has to
    // be spelled out, because it is the pre-ISS-1015 predicate and no code holds
    // it any more — that is what a negative control is.
    const now = await costOf(issueCostRollupQuery(pageIds).getSQL());
    const before = await costOf(sql`
        SELECT p.issue_id, coalesce(sum(u.estimated_cost), 0)::float AS cost
        FROM (SELECT DISTINCT issue_id, agent_session_id FROM jobs
              WHERE issue_id IN (${page}) AND agent_session_id IS NOT NULL) p
        INNER JOIN usage_records u
          ON u.session_id ~ '^[0-9a-fA-F-]{36}$' AND u.session_id::uuid = p.agent_session_id
        GROUP BY p.issue_id`);
    expect(now.text).not.toMatch(/session_id\)::uuid/);
    expect(before.text).toMatch(/session_id\)::uuid/);
    expect(now.total).toBeLessThan(before.total);
  });
});
