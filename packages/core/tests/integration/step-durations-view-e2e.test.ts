/**
 * ISS-516 — pipeline_run_step_durations must never produce negative durations.
 *
 * Regression for the defect closed-unimplemented twice (ISS-270, ISS-482):
 * the view aggregated EVERY job span — including cancelled / failed /
 * zero-ack-reaped jobs whose `finished_at` is stamped by the cleanup path
 * BEFORE the span start — so `duration_seconds` went negative and
 * forge_metrics_project_step_durations returned impossible negative p50/avg.
 *
 * Migration 0128 scopes the view to `jobs.status = 'done'` and guards
 * `finished_at >= COALESCE(agent_sessions.started_at, jobs.dispatched_at)`.
 * This test drives the REAL view (built by the full journaled migration chain,
 * incl. 0128) against real Postgres and asserts:
 *   - only `done` rows with a valid span appear (cancelled/failed/inverted excluded),
 *   - every `duration_seconds >= 0`,
 *   - the metrics aggregation (percentile_disc(0.5/0.95) + avg over
 *     duration_seconds) yields p50/p95/avg all `>= 0`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-516 pipeline_run_step_durations non-negative', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /** Insert one system-kind pipeline_run and return its id. */
  async function insertRun(projectId: string): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${null}, 'system', 'completed', now())
    `);
    return runId;
  }

  /**
   * Seed one job (+ optional agent_session + usage_record) under a run.
   * `spanStartOffsetMin`/`finishedOffsetMin` are minutes-ago relative to now;
   * when finished is older than the span start the span is inverted.
   */
  async function seedJob(
    projectId: string,
    runId: string,
    opts: {
      status: 'done' | 'cancelled' | 'failed';
      type?: string;
      sessionStartOffsetMin: number | null; // null → no session row (dispatched_at fallback)
      dispatchedOffsetMin: number;
      finishedOffsetMin: number;
      costUsd?: number;
    },
  ): Promise<void> {
    const jobId = randomUUID();
    const type = opts.type ?? 'code';
    let sessionId: string | null = null;
    if (opts.sessionStartOffsetMin !== null) {
      sessionId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, started_at, metadata)
        VALUES (
          ${sessionId}, ${projectId}, ${runId}, 'completed',
          now() - (${opts.sessionStartOffsetMin}::int * interval '1 minute'), '{}'::jsonb
        )
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status,
        payload, created_by, agent_session_id, pipeline_run_id,
        dispatched_at, finished_at, queued_at
      )
      VALUES (
        ${jobId}, ${projectId}, ${null}, ${type}, ${opts.status},
        '{}'::jsonb,
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        ${sessionId}, ${runId},
        now() - (${opts.dispatchedOffsetMin}::int * interval '1 minute'),
        now() - (${opts.finishedOffsetMin}::int * interval '1 minute'),
        now() - (${opts.dispatchedOffsetMin + 1}::int * interval '1 minute')
      )
    `);
    if (opts.costUsd != null && sessionId) {
      await harness.db.execute(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at, session_id)
        VALUES (${randomUUID()}, ${projectId}, 'cli', 'sonnet', ${opts.costUsd}::real, now(), ${sessionId})
      `);
    }
  }

  it('excludes non-done + inverted spans and never returns a negative duration', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);

    // (1) done + valid span: started 10m ago, finished 5m ago → +300s.
    await seedJob(project.id, runId, {
      status: 'done',
      type: 'code',
      sessionStartOffsetMin: 10,
      dispatchedOffsetMin: 10,
      finishedOffsetMin: 5,
      costUsd: 0.5,
    });
    // (2) done + NULL session → start derives from dispatched_at (8m ago),
    //     finished 3m ago → +300s. Exercises the COALESCE fallback.
    await seedJob(project.id, runId, {
      status: 'done',
      type: 'triage',
      sessionStartOffsetMin: null,
      dispatchedOffsetMin: 8,
      finishedOffsetMin: 3,
    });
    // (3) cancelled + INVERTED span: finished 10m ago but dispatched 5m ago →
    //     would be -300s. Must be excluded by status filter.
    await seedJob(project.id, runId, {
      status: 'cancelled',
      type: 'code',
      sessionStartOffsetMin: null,
      dispatchedOffsetMin: 5,
      finishedOffsetMin: 10,
    });
    // (4) failed + INVERTED span. Excluded by status filter (failed excluded).
    await seedJob(project.id, runId, {
      status: 'failed',
      type: 'review',
      sessionStartOffsetMin: 2,
      dispatchedOffsetMin: 2,
      finishedOffsetMin: 9,
    });

    // --- raw view: only the two done rows, both non-negative ----------------
    // 4 jobs seeded; the cancelled + failed (inverted-span) rows must be gone,
    // leaving exactly the two `done` steps. Read the view directly — joining
    // back to jobs on (run_id, type) would double-count, since the excluded
    // cancelled job shares run+type='code' with the surviving done job.
    const viewRows = await harness.db.execute<{
      step: string;
      duration_seconds: number;
    }>(sql`
      SELECT step, duration_seconds
      FROM pipeline_run_step_durations
      WHERE project_id = ${project.id}
      ORDER BY step
    `);
    expect(viewRows).toHaveLength(2);
    expect(viewRows.map((r) => r.step)).toEqual(['code', 'triage']);
    for (const r of viewRows) {
      expect(Number(r.duration_seconds)).toBeGreaterThanOrEqual(0);
    }

    // --- metrics aggregation (mirrors forge_metrics.project_step_durations) --
    const agg = await harness.db.execute<{
      step: string;
      p50_s: number | null;
      p95_s: number | null;
      avg_s: number | null;
      n: number;
    }>(sql`
      SELECT step,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY duration_seconds) AS p50_s,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s,
             avg(duration_seconds)::float AS avg_s,
             count(*)::int AS n
      FROM pipeline_run_step_durations
      WHERE project_id = ${project.id}
        AND started_at >= now() - (7::int * interval '1 day')
      GROUP BY step
    `);
    expect(agg.length).toBeGreaterThan(0);
    for (const row of agg) {
      expect(['code', 'triage']).toContain(row.step);
      expect(Number(row.p50_s)).toBeGreaterThanOrEqual(0);
      expect(Number(row.p95_s)).toBeGreaterThanOrEqual(0);
      expect(Number(row.avg_s)).toBeGreaterThanOrEqual(0);
    }
  });
});
