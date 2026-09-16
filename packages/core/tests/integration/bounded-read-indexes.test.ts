/**
 * ISS-1022 — the six indexes 0250 adds, each shown used by the query it serves.
 *
 * An index that exists proves nothing: the question is whether the planner
 * picks it, and that answer is a function of the fixture, not of the query.
 * Measured on this branch while writing it, the same pairing question answered
 * three different ways under three fixtures — a 12,000-row even-mix seed, a
 * 128,000-row seed at correlation -0.54, and a 128,000-row seed at the live
 * deployment's 0.969. So the seed below fixes all three variables the planner
 * reads: row count at the deployment's order of magnitude, the deployment's
 * own action distribution, and ascending insert order so correlation matches
 * it. `ANALYZE` runs before any plan is read. Relax any of the three and these
 * assertions stop measuring the deployment they claim to be about.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cycleTimeTransitionsSql } from '../../src/pipeline/cycle-time-sql.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * `activity_log.action` as beta carried it on 2026-09-15, as cumulative
 * per-mille cut points. Held as a literal table rather than described in prose
 * so the acceptance fixture is one thing and not a judgement call.
 */
const ACTION_MIX: Array<[string, number]> = [
  ['comment.created', 345],
  ['issue.statusChanged', 633],
  ['issue.updated', 834],
  ['issue.attachment.uploaded', 892],
  ['issue.dependency.added', 947],
  ['issue.created', 1000],
];

const ACTIVITY_ROWS = 120_000;
const OTHER_ROWS = 8_000;
const ISSUES = 200;

describe('ISS-1022 · the 0250 indexes are the ones the planner picks', () => {
  let harness: TestDatabase;
  let projectId: string;
  let userId: string;
  let issueId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    userId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;

    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      SELECT gen_random_uuid(), ${projectId}, g, 'seeded ' || g, 'open', ${userId}
      FROM generate_series(1, ${ISSUES}) g
    `);
    const [firstIssue] = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM issues WHERE project_id = ${projectId} ORDER BY iss_seq LIMIT 1`,
    );
    issueId = firstIssue?.id as string;

    const actionCase = sql.join(
      ACTION_MIX.map(([name, upTo]) => sql`WHEN g % 1000 < ${upTo} THEN ${name}`),
      sql` `,
    );
    await harness.db.execute(sql`
      INSERT INTO activity_log (id, issue_id, actor_type, actor_id, action, payload, created_at)
      SELECT gen_random_uuid(),
             (SELECT id FROM issues WHERE project_id = ${projectId} AND iss_seq = (g % ${ISSUES}) + 1),
             'user', ${userId},
             CASE ${actionCase} ELSE 'issue.created' END,
             jsonb_build_object('to', 'closed', 'from', 'open'),
             now() - ((${ACTIVITY_ROWS} - g) * interval '5 minutes')
      FROM generate_series(1, ${ACTIVITY_ROWS}) g
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      SELECT gen_random_uuid(), ${projectId}, 'pm', 'completed', now() - ((${OTHER_ROWS} - g) * interval '1 hour')
      FROM generate_series(1, ${OTHER_ROWS}) g
    `);
    await harness.db.execute(sql`
      INSERT INTO usage_records (id, source, model, recorded_at, project_id, estimated_cost)
      SELECT gen_random_uuid(), 'seed', 'm', now() - ((${OTHER_ROWS} - g) * interval '1 hour'), ${projectId}, 0.01
      FROM generate_series(1, ${OTHER_ROWS}) g
    `);
    await harness.db.execute(sql`
      INSERT INTO notifications (id, user_id, type, title, created_at, read)
      SELECT gen_random_uuid(), ${userId}, 'mention', 'n' || g, now() - ((${OTHER_ROWS} - g) * interval '1 hour'), g % 2 = 0
      FROM generate_series(1, ${OTHER_ROWS}) g
    `);
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body, created_at)
      SELECT gen_random_uuid(), ${issueId}, ${userId}, 'c' || g, now() - ((${OTHER_ROWS} - g) * interval '1 hour')
      FROM generate_series(1, ${OTHER_ROWS}) g
    `);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, blocker_kind, steps, created_at)
      SELECT gen_random_uuid(), ${projectId},
             (SELECT id FROM issues WHERE project_id = ${projectId} AND iss_seq = (g % ${ISSUES}) + 1),
             'human',
             jsonb_build_array(jsonb_build_object('round', 1, 'prompt', 'p', 'askedAt', now()::text,
                                                  'answerShape', 'free_text', 'needed', 'n')),
             now() - ((${OTHER_ROWS} - g) * interval '1 hour')
      FROM generate_series(1, ${OTHER_ROWS}) g
    `);
    await harness.db.execute(sql`ANALYZE`);
  }, 300_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const plan = async (query: ReturnType<typeof sql>): Promise<string> => {
    const rows = await harness.db.execute<Record<string, string>>(
      sql`EXPLAIN (COSTS OFF) ${query}`,
    );
    return [...rows].map((r) => Object.values(r)[0]).join('\n');
  };

  it('seeds the fixture at the live order of magnitude and distribution', async () => {
    const [counts] = await harness.db.execute<{ n: string; status_changed: string }>(sql`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE action = 'issue.statusChanged')::text AS status_changed
      FROM activity_log
    `);
    expect(Number(counts?.n)).toBeGreaterThanOrEqual(100_000);
    const share = Number(counts?.status_changed) / Number(counts?.n);
    expect(share).toBeGreaterThan(0.278);
    expect(share).toBeLessThan(0.298);

    const [recent] = await harness.db.execute<{ n: string; status_changed: string }>(sql`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE action = 'issue.statusChanged')::text AS status_changed
      FROM activity_log WHERE created_at >= now() - interval '30 days'
    `);
    const recentShare = Number(recent?.status_changed) / Number(recent?.n);
    expect(Math.abs(recentShare - share)).toBeLessThan(0.015);

    const [stats] = await harness.db.execute<{ correlation: string }>(sql`
      SELECT correlation::text AS correlation FROM pg_stats
      WHERE tablename = 'activity_log' AND attname = 'created_at'
    `);
    expect(Number(stats?.correlation)).toBeGreaterThan(0.9);
  });

  it('takes activity_log_created_at_idx for the cycle-time window even when the composite exists', async () => {
    const cycleTime = cycleTimeTransitionsSql([projectId], 30);
    const alone = await plan(cycleTime);
    expect(alone).toContain('activity_log_created_at_idx');
    expect(alone).not.toContain('Seq Scan on activity_log');

    try {
      await harness.db.execute(
        sql`CREATE INDEX activity_log_action_created_idx ON activity_log (action, created_at)`,
      );
      await harness.db.execute(sql`ANALYZE activity_log`);
      const both = await plan(cycleTime);
      expect(both).toContain('activity_log_created_at_idx');
      expect(both).not.toContain('activity_log_action_created_idx');
    } finally {
      await harness.db.execute(sql`DROP INDEX IF EXISTS activity_log_action_created_idx`);
      await harness.db.execute(sql`ANALYZE activity_log`);
    }
  });

  it("reads activity_log once for readPulseFlow's pre-window baseline", async () => {
    const text = await plan(sql`
      SELECT count(*) FILTER (WHERE a.payload ->> 'to' IN ('closed', 'dropped'))::int AS closed,
             count(*) FILTER (WHERE a.payload ->> 'from' IN ('closed', 'dropped'))::int AS reopened
      FROM activity_log a JOIN issues i ON i.id = a.issue_id
      WHERE i.project_id IN (${projectId})
        AND a.created_at < now() - interval '42 days'
        AND a.action = 'issue.statusChanged'
    `);
    expect(text.match(/Scan on activity_log/g)).toHaveLength(1);
  });

  it('serves the unfiltered admin audit page from activity_log_created_at_idx', async () => {
    const text = await plan(sql`
      SELECT id, action, created_at FROM activity_log ORDER BY created_at DESC LIMIT 50 OFFSET 0
    `);
    expect(text).toContain('activity_log_created_at_idx');
  });

  it('serves the trailing-24h admin spend read from usage_records_recorded_at_idx', async () => {
    const text = await plan(sql`
      SELECT coalesce(sum(estimated_cost), 0)::float FROM usage_records
      WHERE recorded_at >= now() - interval '24 hours'
    `);
    expect(text).toContain('usage_records_recorded_at_idx');
  });

  it('serves the admin active-workspace count from pipeline_runs_started_at_only_idx', async () => {
    const text = await plan(sql`
      SELECT count(distinct project_id)::int FROM pipeline_runs
      WHERE started_at >= now() - (24::int * interval '1 hour')
    `);
    expect(text).toContain('pipeline_runs_started_at_only_idx');
  });

  it('serves the per-issue question read from agent_questions_issue_idx', async () => {
    const text = await plan(sql`
      SELECT id, status FROM agent_questions
      WHERE issue_id = ${issueId} AND project_id = ${projectId}
      ORDER BY created_at DESC, id DESC
    `);
    expect(text).toContain('agent_questions_issue_idx');
  });

  it('serves the comment thread page from comments_issue_created_idx', async () => {
    const text = await plan(sql`
      SELECT id, created_at FROM comments
      WHERE issue_id = ${issueId} AND parent_id IS NULL
      ORDER BY created_at ASC, id ASC LIMIT 51
    `);
    expect(text).toContain('comments_issue_created_idx');
  });

  it('serves the unfiltered notification list from notifications_user_created_idx', async () => {
    const text = await plan(sql`
      SELECT id, title FROM notifications WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 25 OFFSET 0
    `);
    expect(text).toContain('notifications_user_created_idx');
  });
});
