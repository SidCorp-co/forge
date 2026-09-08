/**
 * A job row that has finished is history, not a lease.
 *
 * The backlog's first exclusion asked whether a job row EXISTS, with no status
 * filter, while the two beside it ask for `running`/`paused`. So an issue whose
 * run was cancelled or failed carried a terminal row forever and could never be
 * offered again — every project that ran under the pre-ISS-933 dispatcher had a
 * row on every issue it had touched, which is the whole backlog.
 *
 * Only real Postgres decides this: the claim is which rows a `NOT EXISTS`
 * subquery keeps, and a mocked repository answers from whatever the mock was
 * told to hold.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const ENTRY_OPEN = { pipelineConfig: { enabled: true } };

describe('a finished job does not hide the issue it ran on (real Postgres)', () => {
  let harness: TestDatabase;
  let userId: string;
  let projectId: string;
  let deviceId: string;
  let seq = 0;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    seq = 0;
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify(ENTRY_OPEN)}::jsonb
      WHERE id = ${projectId}
    `);
    deviceId = (await createTestDevice(harness.db, userId, { name: 'entry-box' })).id;
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type, status)
      VALUES (${randomUUID()}, ${projectId}, ${deviceId}, 'entry-runner', 'claude-code', 'online')
    `);
  });

  async function issueWithJob(
    jobStatus: string | null,
    opts: { runStatus?: string } = {},
  ): Promise<string> {
    seq += 1;
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'open', ${userId})
    `);
    if (jobStatus === null) return `ISS-${seq}`;

    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', ${opts.runStatus ?? 'cancelled'}, now())
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by,
                        queued_at)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, 'drive', ${jobStatus},
              ${userId}, now() - interval '1 hour')
    `);
    return `ISS-${seq}`;
  }

  async function offered(): Promise<string[]> {
    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    const rows = await readAdmissibleIssues({ deviceId });
    return rows.map((r) => r.issueKey ?? '');
  }

  // cm:guard the falsifying case, and the only one that separates "no job row exists" from "no job row is live". Every other test here passes against the unfiltered `NOT EXISTS` too.
  it('offers an issue whose only job was cancelled', async () => {
    const key = await issueWithJob('cancelled');
    expect(await offered()).toEqual([key]);
  });

  it('offers an issue whose only job failed', async () => {
    const key = await issueWithJob('failed');
    expect(await offered()).toEqual([key]);
  });

  it('offers an issue whose only job finished done without closing it', async () => {
    const key = await issueWithJob('done');
    expect(await offered()).toEqual([key]);
  });

  it.each(['queued', 'dispatched', 'running'])('withholds an issue whose job is %s', async (s) => {
    await issueWithJob(s, { runStatus: 'running' });
    expect(await offered()).toEqual([]);
  });

  // cm:guard `held` is NOT terminal — it is the deliberate fourth shape of a job a session still owns (ISS-923), so it must keep withholding the issue even though no job is executing.
  it('withholds an issue whose job is held', async () => {
    await issueWithJob('held', { runStatus: 'running' });
    expect(await offered()).toEqual([]);
  });

  // cm:guard a terminal job under a run that is still open stays withheld by the RUN clause. Relaxing the job clause must not reach past it, or an issue with live work is offered twice.
  it('withholds an issue whose job is done but whose run is still running', async () => {
    await issueWithJob('done', { runStatus: 'running' });
    expect(await offered()).toEqual([]);
  });

  it('withholds an issue whose job is done under a paused run', async () => {
    await issueWithJob('done', { runStatus: 'paused' });
    expect(await offered()).toEqual([]);
  });

  it('offers the never-touched issue and the finished one, oldest first', async () => {
    const first = await issueWithJob('cancelled');
    const second = await issueWithJob(null);
    expect(await offered()).toEqual([first, second]);
  });

  /**
   * The case this clause could be reached past — a live job the relaxed filter
   * still sees, sitting under a run that has already closed — cannot be built.
   * `trg_jobs_no_active_under_terminal_run` (migration 0113, widened to `held`
   * by 0178) downgrades it on the way in, which is the ISS-923 forward half
   * enforced in the DB rather than in a caller.
   *
   * So this asserts the two halves together: the trigger writes `cancelled`,
   * and the row is therefore offered rather than hidden by a job nothing owns.
   */
  it('cannot hold a live job under a closed run, so the issue is offered', async () => {
    seq += 1;
    const issueId = randomUUID();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, ${seq}, 'mixed', 'open', ${userId})
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'cancelled', now())
    `);
    for (const s of ['done', 'failed', 'cancelled', 'running']) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by,
                          queued_at)
        VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, 'drive', ${s}, ${userId},
                now())
      `);
    }

    const live = (await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM jobs
      WHERE issue_id = ${issueId} AND status NOT IN ('done', 'failed', 'cancelled')
    `)) as unknown as Array<{ n: number }>;
    expect(live[0]?.n).toBe(0);

    expect(await offered()).toEqual([`ISS-${seq}`]);
  });
});
