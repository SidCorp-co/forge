/**
 * `phase_step_durations` vs `pipeline_run_step_durations`, against real
 * Postgres.
 *
 * The journal-backed view only earns the right to replace the job-backed one if
 * it reports the same thing about the same staged work. "Same" here means
 * EXCEPT returns nothing in BOTH directions on the shared columns — not that a
 * couple of spot-checked numbers matched, which is how a view with an inverted
 * span or a dropped row still passes.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const SHARED_COLUMNS =
  'run_id, issue_id, project_id, step, started_at, finished_at, duration_seconds, cost_usd, device_id, model_used';

describe('step-duration view parity E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let issueId: string;
  let ownerId: string;
  let runId: string;
  let backfillPhaseJournal: () => Promise<{ runs: number; rows: number }>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    ({ backfillPhaseJournal } = await import('../../src/pipeline/phase-journal-backfill.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 1, 'parity fixture', 'open', ${owner.id})
    `);
    runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'completed', now())
    `);
  });

  /** One finished job with its session, so both views see the same span. */
  async function insertStep(
    type: string,
    status: string,
    startMinutesAgo: number,
    endMinutesAgo: number,
    opts: { withSession?: boolean; costUsd?: number } = {},
  ): Promise<void> {
    const withSession = opts.withSession ?? true;
    const jobId = randomUUID();
    const sessionId = withSession ? randomUUID() : null;

    if (sessionId) {
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, started_at, metadata)
        VALUES (${sessionId}, ${projectId}, ${runId}, 'completed',
                now() - make_interval(mins => ${startMinutesAgo}), '{}'::jsonb)
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload,
                        created_by, agent_session_id, queued_at, dispatched_at, finished_at)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${type}, ${status}, '{}'::jsonb,
              ${ownerId}, ${sessionId},
              now() - make_interval(mins => ${startMinutesAgo + 1}),
              now() - make_interval(mins => ${startMinutesAgo}),
              now() - make_interval(mins => ${endMinutesAgo}))
    `);
    if (sessionId && opts.costUsd !== undefined) {
      await harness.db.execute(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at, session_id)
        VALUES (${randomUUID()}, ${projectId}, 'cli', 'sonnet', ${opts.costUsd}::real, now(), ${sessionId})
      `);
    }
  }

  async function difference(left: string, right: string): Promise<unknown[]> {
    const rows = await harness.db.execute(
      sql.raw(
        `SELECT ${SHARED_COLUMNS} FROM ${left} EXCEPT SELECT ${SHARED_COLUMNS} FROM ${right}`,
      ),
    );
    return [...rows];
  }

  it('agrees row for row on a run covering every outcome the staged driver produces', async () => {
    await insertStep('plan', 'done', 60, 55, { costUsd: 0.25 });
    await insertStep('code', 'failed', 50, 45, { costUsd: 1.5 });
    await insertStep('code', 'done', 40, 30, { costUsd: 2 });
    await insertStep('review', 'cancelled', 25, 20);
    await insertStep('test', 'done', 15, 10, { withSession: false });

    expect(await backfillPhaseJournal()).toMatchObject({ runs: 1, rows: 5 });

    expect(await difference('pipeline_run_step_durations', 'phase_step_durations')).toEqual([]);
    expect(await difference('phase_step_durations', 'pipeline_run_step_durations')).toEqual([]);
  });

  // cm:guard the inverted span is the case 0128 was written for: a reaped job whose finished_at predates its start must yield NULL duration in BOTH views — clamping to 0 in either one drags every p50 down and the EXCEPT above would not catch it if only one view were tested
  it('agrees that an inverted span has no duration rather than a zero one', async () => {
    await insertStep('code', 'done', 10, 30);

    await backfillPhaseJournal();

    const rows = await harness.db.execute(sql`
      SELECT duration_seconds FROM phase_step_durations WHERE run_id = ${runId}
    `);
    expect(rows[0]?.duration_seconds).toBeNull();
    expect(await difference('pipeline_run_step_durations', 'phase_step_durations')).toEqual([]);
    expect(await difference('phase_step_durations', 'pipeline_run_step_durations')).toEqual([]);
  });

  it('keeps counting cost on a failed step, which the budget gate depends on', async () => {
    await insertStep('code', 'failed', 40, 30, { costUsd: 3.5 });
    await backfillPhaseJournal();

    const rows = await harness.db.execute(sql`
      SELECT duration_seconds, cost_usd FROM phase_step_durations WHERE run_id = ${runId}
    `);
    expect(rows[0]).toMatchObject({ duration_seconds: null, cost_usd: 3.5 });
  });

  // cm:guard the ONLY thing separating the two phase-name eras (ISS-921). A date cannot do it — the fix was a seed, not a gate, so an ordinal written next week must still read as unnamed. Both halves are asserted here or a regex that matches everything, or nothing, passes silently.
  it('marks an ordinal phase name unnamed and a descriptive one named', async () => {
    const declare = async (phase: string) =>
      harness.db.execute(sql`
        INSERT INTO phase_journal (id, project_id, run_id, issue_id, phase, attempt, source,
                                   outcome, started_at, ended_at)
        VALUES (${randomUUID()}, ${projectId}, ${runId}, ${issueId}, ${phase}, 1, 'agent',
                'ok', now() - make_interval(mins => 10), now())
      `);
    await declare('phase-4');
    await declare('implement');
    await declare('phase-4-implement');

    const rows = await harness.db.execute(sql`
      SELECT step, step_named FROM phase_step_durations WHERE run_id = ${runId} ORDER BY step
    `);
    expect([...rows]).toEqual([
      { step: 'implement', step_named: true },
      { step: 'phase-4', step_named: false },
      { step: 'phase-4-implement', step_named: true },
    ]);
  });

  it('reports the attempt number the old view could not express', async () => {
    await insertStep('code', 'done', 60, 50);
    await insertStep('review', 'failed', 45, 40);
    await insertStep('code', 'done', 35, 30);
    await backfillPhaseJournal();

    const rows = await harness.db.execute(sql`
      SELECT step, attempt FROM phase_step_durations WHERE run_id = ${runId}
      ORDER BY started_at
    `);
    expect([...rows]).toEqual([
      { step: 'code', attempt: 1 },
      { step: 'review', attempt: 1 },
      { step: 'code', attempt: 2 },
    ]);
  });
});
