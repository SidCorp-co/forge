/**
 * Backfilling the phase journal from staged history, against real Postgres.
 *
 * Two properties decide whether this is safe to leave running on a live
 * instance, and neither can be observed with a mocked db: it must not write a
 * run that is still moving, and running it twice must not change the result.
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

describe('phase journal backfill E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let runId: string;
  let ownerId: string;
  let backfillPhaseJournal: (batchRuns?: number) => Promise<{ runs: number; rows: number }>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-pepper-at-least-32-chars-long-abcdef-12';
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
    runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, NULL, 'system', 'running', now())
    `);
  });

  async function insertJob(
    type: string,
    status: string,
    minutesAgo: number,
    finished = true,
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, payload, created_by,
                        queued_at, dispatched_at, finished_at)
      VALUES (${id}, ${projectId}, ${runId}, ${type}, ${status}, '{}'::jsonb, ${ownerId},
              now() - make_interval(mins => ${minutesAgo}),
              now() - make_interval(mins => ${minutesAgo}),
              ${finished ? sql`now() - make_interval(mins => ${minutesAgo - 1})` : sql`NULL`})
    `);
    return id;
  }

  async function journalRows(): Promise<Array<Record<string, unknown>>> {
    const rows = await harness.db.execute(sql`
      SELECT phase, attempt, outcome, source, job_id FROM phase_journal
      WHERE run_id = ${runId} ORDER BY started_at, phase
    `);
    return [...rows] as Array<Record<string, unknown>>;
  }

  it('writes one row per finished job, numbering a repeated phase', async () => {
    await insertJob('code', 'done', 30);
    await insertJob('review', 'failed', 20);
    await insertJob('code', 'done', 10);

    expect(await backfillPhaseJournal()).toEqual({ runs: 1, rows: 3 });
    expect((await journalRows()).map((r) => [r.phase, r.attempt, r.outcome])).toEqual([
      ['code', 1, 'ok'],
      ['review', 1, 'failed'],
      ['code', 2, 'ok'],
    ]);
  });

  // cm:guard the property the backfill's run-selection guard exists for: numbering comes from the run's WHOLE job list, so writing a run that is still moving would hand attempt 1 to the job that happened to finish first and the unique index would then swallow the real first attempt
  it('skips a run that still has an unfinished job, and picks it up once it finishes', async () => {
    await insertJob('code', 'done', 30);
    const running = await insertJob('review', 'running', 10, false);

    expect(await backfillPhaseJournal()).toEqual({ runs: 0, rows: 0 });
    expect(await journalRows()).toHaveLength(0);

    await harness.db.execute(sql`
      UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${running}
    `);

    expect(await backfillPhaseJournal()).toEqual({ runs: 1, rows: 2 });
    expect((await journalRows()).map((r) => r.phase)).toEqual(['code', 'review']);
  });

  it('is idempotent — a second pass writes nothing and changes nothing', async () => {
    await insertJob('plan', 'done', 30);
    await insertJob('code', 'cancelled', 20);
    await backfillPhaseJournal();
    const first = await journalRows();

    expect(await backfillPhaseJournal()).toEqual({ runs: 0, rows: 0 });
    expect(await journalRows()).toEqual(first);
  });

  it('records a cancelled job as abandoned rather than a failure', async () => {
    await insertJob('code', 'cancelled', 30);
    await backfillPhaseJournal();

    expect((await journalRows())[0]).toMatchObject({ outcome: 'abandoned', source: 'system' });
  });

  it('leaves a run with no jobs alone instead of writing an empty history', async () => {
    expect(await backfillPhaseJournal()).toEqual({ runs: 0, rows: 0 });
  });
});
