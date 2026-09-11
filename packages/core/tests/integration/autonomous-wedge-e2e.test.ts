/**
 * ISS-890 — the autonomous driver wedge, against a real Postgres.
 *
 * The unit suite mocks `db.execute`, so it can only assert what the pass does
 * with a row it is HANDED. Every control that matters here is a clause in the
 * SELECT — a `needs_info` issue, a live job, a staged project, a run that is
 * not running — and against a mock those controls cannot fail. They are only
 * evidence when the SQL itself runs.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:guard an EMPTY config is the post-migration shape and must be in this net: ISS-897 stripped `mode` from all 38 rows, and the predicate is `coalesce(..., 'autonomous') <> 'staged'` for exactly that reason.
const AUTONOMOUS = { pipelineConfig: { enabled: true } };
// cm:guard the pre-ISS-897 `mode: 'staged'` key a project row may still carry before the migration reaches it. It is the ONLY value that excludes a project now, and the exclusion is what stops this net acting on an issue a staged step still owned.
// cm:why the legacy `mode` key a project row may still carry in its jsonb — ISS-895 removed it from the schema, and `pipelineConfigSchema` drops unknown keys on parse, so the row must behave exactly like one that never had it
const LEGACY_STAGED_ROW = { pipelineConfig: { enabled: true, mode: 'staged' } };

let harness: TestDatabase;
let userId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const user = await createTestUser(harness.db);
  userId = user.id;
});

/** A wedge specimen: the shape ISS-880 sat in for 2h15m. */
async function seed(opts: {
  agentConfig?: unknown;
  issueStatus?: string;
  runStatus?: string;
  jobStatus?: string;
  jobType?: string;
  idle?: string;
  extraJobStatus?: string;
  merged?: boolean;
}): Promise<{ projectId: string; issueId: string; runId: string }> {
  const project = await createTestProject(harness.db, userId);
  await harness.db.execute(sql`
    UPDATE projects SET agent_config = ${JSON.stringify(opts.agentConfig ?? AUTONOMOUS)}::jsonb
    WHERE id = ${project.id}
  `);

  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, updated_at, merged_at)
    VALUES (${issueId}, ${project.id}, 'wedge specimen', ${opts.issueStatus ?? 'in_progress'},
            ${userId}, now() - interval '${sql.raw(opts.idle ?? '30 minutes')}',
            ${opts.merged ? sql`now() - interval '2 hours'` : sql`NULL`})
  `);

  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
    VALUES (${runId}, ${project.id}, ${issueId}, 'issue', ${opts.runStatus ?? 'running'}, 'in_progress')
  `);

  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, created_at)
    VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${runId}, ${userId},
            ${opts.jobType ?? 'drive'}, ${opts.jobStatus ?? 'done'}, now() - interval '1 hour')
  `);

  if (opts.extraJobStatus) {
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, created_at)
      VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${runId}, ${userId},
              'drive', ${opts.extraJobStatus}, now() - interval '2 hours')
    `);
  }

  return { projectId: project.id, issueId, runId };
}

async function statusOf(issueId: string): Promise<string> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`SELECT status FROM issues WHERE id = ${issueId}`,
  );
  return rows[0]?.status ?? '<missing>';
}

describe('ISS-890 autonomous driver wedge (real Postgres)', () => {
  it('rolls the ISS-880 shape back to the entry status', async () => {
    const { issueId } = await seed({});
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    const reset = await resetAutonomousWedgesOnce();

    expect(reset).toBe(1);
    expect(await statusOf(issueId)).toBe('open');
  });

  it('leaves a needs_info issue alone — a human is being waited on, not a wedge', async () => {
    const { issueId } = await seed({ issueStatus: 'needs_info' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('needs_info');
  });

  // cm:guard the queued job is seeded OLDER than the `done` one on purpose: seed it newer and the LATERAL picks it, `lj.status = 'done'` excludes the row, and this test passes with the NOT EXISTS clause deleted — measured, it did.
  it('leaves an issue that already has a queued job alone', async () => {
    const { issueId } = await seed({ extraJobStatus: 'queued' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  // cm:guard a leftover `mode: 'staged'` key must NOT exclude the row. This asserted the opposite until ISS-895 deleted `mode` from the schema; the pass now has no project filter at all, and a row whose jsonb still carries the retired key parses to the same config as one that does not — so it gets the same rescue. Re-adding an exclusion here would leave whoever still has the key wedged with no pass that can see them.
  it('rescues a row still carrying the retired `mode` key, exactly like one that is not', async () => {
    const { issueId } = await seed({ agentConfig: LEGACY_STAGED_ROW });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(1);
    expect(await statusOf(issueId)).toBe('open');
  });

  it('leaves a paused run alone — a pause is a decision somebody made', async () => {
    const { issueId } = await seed({ runStatus: 'paused' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  it('leaves a failed last job alone — the retry machinery already owns it', async () => {
    const { issueId } = await seed({ jobStatus: 'failed' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  it('waits out the grace period rather than racing the agent’s own final write', async () => {
    const { issueId } = await seed({ idle: '2 minutes' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  describe('the rescue cap', () => {
    async function rescueState(runId: string): Promise<{ count: number; doneDriveJobs: number }> {
      const rows = await harness.db.execute<{ s: { count: number; doneDriveJobs: number } }>(
        sql`SELECT metadata -> 'autonomousRescue' AS s FROM pipeline_runs WHERE id = ${runId}`,
      );
      return rows[0]?.s ?? { count: 0, doneDriveJobs: 0 };
    }

    /** Put the issue back in the wedge shape the pass just rolled it out of. */
    async function rewedge(issueId: string, projectId: string, runId: string): Promise<void> {
      await harness.db.execute(sql`
        UPDATE issues SET status = 'in_progress',
          updated_at = now() - interval '30 minutes' WHERE id = ${issueId}
      `);
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, created_at)
        VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, ${userId}, 'drive', 'done', now())
      `);
    }

    it('charges one rescue per rollback and stops at the cap, parking the issue for a human', async () => {
      const { projectId, issueId, runId } = await seed({});
      const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
      const { AUTONOMOUS_RESCUE_CAP } = await import('../../src/pipeline/autonomous-rescue-cap.js');

      for (let i = 0; i < AUTONOMOUS_RESCUE_CAP; i++) {
        expect(await resetAutonomousWedgesOnce()).toBe(1);
        expect(await statusOf(issueId)).toBe('open');
        expect((await rescueState(runId)).count).toBe(i + 1);
        await rewedge(issueId, projectId, runId);
      }

      expect(await resetAutonomousWedgesOnce()).toBe(0);
      expect(await statusOf(issueId)).toBe('needs_info');

      const comments = await harness.db.execute<{ body: string }>(
        sql`SELECT body FROM comments WHERE issue_id = ${issueId}`,
      );
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain('waiting on you');
    });

    it('does not spend the allowance on a run that made progress in between', async () => {
      const { projectId, issueId, runId } = await seed({});
      const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
      const { AUTONOMOUS_RESCUE_CAP } = await import('../../src/pipeline/autonomous-rescue-cap.js');

      for (let i = 0; i < AUTONOMOUS_RESCUE_CAP + 2; i++) {
        expect(await resetAutonomousWedgesOnce()).toBe(1);
        await rewedge(issueId, projectId, runId);
        // cm:why a second done drive job per cycle stands in for a human answering at `needs_info` and the resume minting its own job — the run's done-drive count then grows by two, which is the only evidence the cap has that the issue moved
        await harness.db.execute(sql`
          INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, created_at)
          VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${runId}, ${userId}, 'drive', 'done', now())
        `);
      }

      expect(await statusOf(issueId)).toBe('in_progress');
      expect((await rescueState(runId)).count).toBe(1);
    });

    it('speaks again on a SECOND park, after a human answered the first', async () => {
      const { projectId, issueId, runId } = await seed({});
      const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
      const { AUTONOMOUS_RESCUE_CAP } = await import('../../src/pipeline/autonomous-rescue-cap.js');

      // cm:guard exactly AUTONOMOUS_RESCUE_CAP rollbacks, counting the one that detects progress. A resumed run does not get a fresh allowance ON TOP of the rescue that noticed the human's answer — that rescue IS the first of the new allowance, and a helper assuming otherwise walks into the cap one cycle early and fails on the rollback, never reaching the comment this test is about.
      const burnToPark = async (): Promise<void> => {
        for (let i = 0; i < AUTONOMOUS_RESCUE_CAP; i++) {
          expect(await resetAutonomousWedgesOnce()).toBe(1);
          await rewedge(issueId, projectId, runId);
        }
        expect(await resetAutonomousWedgesOnce()).toBe(0);
        expect(await statusOf(issueId)).toBe('needs_info');
      };

      await burnToPark();

      // cm:guard ONE job models the human's answer, never two. The resume mints exactly one drive job; growth reads 2 only because the pre-park job counts against a watermark the park did NOT advance. Seed a second job here and growth is 2 either way, so the test passes with `recordAutonomousRescue` wrongly added to `parkForHuman` — measured, it did.
      await rewedge(issueId, projectId, runId);

      await burnToPark();

      const bodies = await harness.db.execute<{ body: string }>(
        sql`SELECT body FROM comments WHERE issue_id = ${issueId}`,
      );
      expect(bodies).toHaveLength(2);
      expect(new Set(bodies.map((b) => b.body)).size).toBe(2);
    });

    it('does not merge-clobber a sibling metadata key the pause writer owns', async () => {
      const { runId } = await seed({});
      await harness.db.execute(sql`
        UPDATE pipeline_runs
        SET metadata = '{"pauseReason":"held_by_a_human"}'::jsonb WHERE id = ${runId}
      `);
      const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

      await resetAutonomousWedgesOnce();

      const rows = await harness.db.execute<{ reason: string | null }>(
        sql`SELECT metadata ->> 'pauseReason' AS reason FROM pipeline_runs WHERE id = ${runId}`,
      );
      expect(rows[0]?.reason).toBe('held_by_a_human');
      expect((await rescueState(runId)).count).toBe(1);
    });
  });
});

describe('a run that DIED, not one that is still open (sidpeak, 2026-09-11)', () => {
  // cm:guard `in_progress` is reachable only from the run that set it: the backlog subtracts the driver statuses and the entry-status rescue does not select it. So a run that ends without moving the issue on strands it with nothing in the system looking again — eleven of them on one project, the oldest eight days old, seven carrying pushed branches.
  it('rolls back a wedge whose run is terminal and whose last job failed', async () => {
    const { issueId } = await seed({ runStatus: 'failed', jobStatus: 'failed' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(1);
    expect(await statusOf(issueId)).toBe('open');
  });

  // cm:guard the run ROW always exists — `jobs.pipeline_run_id` is NOT NULL, so a drive job cannot outlive its run's row and "no run at all" is not a reachable state. Terminal is the whole of what "the run is gone" can mean here.
  it('rolls back a wedge whose run was cancelled under it', async () => {
    const { issueId } = await seed({ runStatus: 'cancelled', jobStatus: 'cancelled' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(1);
    expect(await statusOf(issueId)).toBe('open');
  });

  // cm:guard the refusal that keeps this pass from re-dispatching live production code (ISS-940). Shape A could not reach it — a running run means the work had not shipped — and shape B can, so the mark is read explicitly.
  it('refuses a dead run whose work already shipped, and leaves it for the owed-close detector', async () => {
    const { issueId } = await seed({ runStatus: 'completed', jobStatus: 'done', merged: true });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  // cm:guard the hand-session fence (ISS-940): a draft somebody is building by hand has no drive job, so the LATERAL finds a different type and the row is never a candidate. A pass that stopped reading the job type would roll a live human's issue back and dispatch an agent into their worktree.
  it('leaves an issue whose last job is not the driver alone, dead run or not', async () => {
    const { issueId } = await seed({
      runStatus: 'completed',
      jobType: 'release_batch',
      jobStatus: 'done',
    });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });

  it('leaves a paused run alone even when the pass no longer needs a running one', async () => {
    const { issueId } = await seed({ runStatus: 'paused', jobStatus: 'failed' });
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    expect(await statusOf(issueId)).toBe('in_progress');
  });
});
