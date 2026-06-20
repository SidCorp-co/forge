/**
 * ISS-516 — pipeline_run_step_durations must never produce negative durations,
 * WITHOUT dropping the cost of failed/cancelled jobs.
 *
 * Regression for the defect closed-unimplemented twice (ISS-270, ISS-482):
 * the view computed `duration_seconds` for EVERY job span — including cancelled
 * / failed / zero-ack-reaped jobs whose `finished_at` is stamped by the cleanup
 * path BEFORE the span start — so `duration_seconds` went negative and
 * forge_metrics_project_step_durations returned impossible negative p50/avg.
 *
 * Migration 0128 guards ONLY `duration_seconds` (a CASE that is non-NULL only
 * when `jobs.status = 'done'` AND `finished_at >= COALESCE(agent_sessions
 * .started_at, jobs.dispatched_at)`), leaving the row set — and therefore
 * `cost_usd` — exactly as the 0057 view (all finished jobs). This preserves the
 * budget gate / cost dashboards, which must count tokens burned by failed/
 * cancelled jobs too.
 *
 * This test drives the REAL view (built by the full journaled migration chain,
 * incl. 0128) against real Postgres and asserts:
 *   - the view keeps a row per finished job (done + cancelled + failed),
 *   - non-`done` / inverted rows carry `duration_seconds IS NULL` (not a
 *     negative, not a fake 0),
 *   - every non-NULL `duration_seconds >= 0`,
 *   - `SUM(cost_usd)` still includes failed/cancelled job spend (budget-gate
 *     guard),
 *   - the metrics aggregation (percentile_disc(0.5/0.95) + avg over
 *     duration_seconds, count(duration_seconds) AS n) yields p50/p95/avg all
 *     `>= 0` and a sample size that excludes the non-done rows.
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
   * `*OffsetMin` are minutes-ago relative to now; when finished is older than
   * the span start the span is inverted.
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

  it('NULLs non-done/inverted durations, never goes negative, keeps failed cost', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const runId = await insertRun(project.id);

    // (1) done + valid span: started 10m ago, finished 5m ago → +300s. cost 0.5.
    await seedJob(project.id, runId, {
      status: 'done',
      type: 'code',
      sessionStartOffsetMin: 10,
      dispatchedOffsetMin: 10,
      finishedOffsetMin: 5,
      costUsd: 0.5,
    });
    // (2) done + NULL session → start derives from dispatched_at (8m ago),
    //     finished 3m ago → +300s. Exercises the COALESCE fallback. no cost.
    await seedJob(project.id, runId, {
      status: 'done',
      type: 'triage',
      sessionStartOffsetMin: null,
      dispatchedOffsetMin: 8,
      finishedOffsetMin: 3,
    });
    // (3) cancelled + INVERTED span: session started 5m ago, finished 10m ago →
    //     would be -300s. duration must be NULL; cost 0.25 MUST survive.
    await seedJob(project.id, runId, {
      status: 'cancelled',
      type: 'code',
      sessionStartOffsetMin: 5,
      dispatchedOffsetMin: 5,
      finishedOffsetMin: 10,
      costUsd: 0.25,
    });
    // (4) failed + INVERTED span. duration NULL; cost 0.75 MUST survive.
    await seedJob(project.id, runId, {
      status: 'failed',
      type: 'review',
      sessionStartOffsetMin: 2,
      dispatchedOffsetMin: 2,
      finishedOffsetMin: 9,
      costUsd: 0.75,
    });

    // --- raw view: row per finished job; only done rows carry a duration ------
    // All 4 jobs have finished_at + a span start, so all 4 rows remain (cost
    // parity). The cancelled + failed rows must have duration_seconds IS NULL —
    // never a negative, never a clamped 0. Read the view directly.
    const viewRows = await harness.db.execute<{
      step: string;
      status_dim: string;
      duration_seconds: number | null;
      cost_usd: number;
    }>(sql`
      SELECT v.step,
             j.status AS status_dim,
             v.duration_seconds,
             v.cost_usd
      FROM pipeline_run_step_durations v
      JOIN jobs j ON j.pipeline_run_id = v.run_id AND j.type = v.step
                 AND j.finished_at = v.finished_at
      WHERE v.project_id = ${project.id}
      ORDER BY j.status, v.step
    `);
    expect(viewRows).toHaveLength(4);
    for (const r of viewRows) {
      if (r.status_dim === 'done') {
        expect(r.duration_seconds).not.toBeNull();
        expect(Number(r.duration_seconds)).toBeGreaterThanOrEqual(0);
      } else {
        // cancelled / failed + inverted span → duration excluded as NULL.
        expect(r.duration_seconds).toBeNull();
      }
    }

    // --- cost parity: failed + cancelled spend is NOT dropped (budget gate) ---
    const costRows = await harness.db.execute<{ total: number }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total
      FROM pipeline_run_step_durations
      WHERE project_id = ${project.id}
    `);
    // 0.5 (done) + 0.25 (cancelled) + 0.75 (failed) = 1.5 — all retained.
    expect(Number(costRows[0]?.total)).toBeCloseTo(1.5, 5);

    // --- metrics aggregation (mirrors forge_metrics.project_step_durations) --
    // n = count(duration_seconds) so the non-done 'review'/'code'-cancelled rows
    // don't inflate the sample size.
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
             count(duration_seconds)::int AS n
      FROM pipeline_run_step_durations
      WHERE project_id = ${project.id}
        AND started_at >= now() - (7::int * interval '1 day')
      GROUP BY step
    `);
    const byStep = new Map(agg.map((r) => [r.step, r]));

    // 'code' and 'triage' each have exactly one done span → n=1, non-negative.
    for (const step of ['code', 'triage']) {
      const row = byStep.get(step);
      expect(row).toBeDefined();
      expect(Number(row?.n)).toBe(1);
      expect(Number(row?.p50_s)).toBeGreaterThanOrEqual(0);
      expect(Number(row?.p95_s)).toBeGreaterThanOrEqual(0);
      expect(Number(row?.avg_s)).toBeGreaterThanOrEqual(0);
    }
    // 'review' has only the failed (NULL-duration) row → present for cost, but
    // its duration sample size is 0 and aggregates are NULL (never negative).
    const review = byStep.get('review');
    expect(review).toBeDefined();
    expect(Number(review?.n)).toBe(0);
    expect(review?.p50_s).toBeNull();
    expect(review?.avg_s).toBeNull();
  });
});
