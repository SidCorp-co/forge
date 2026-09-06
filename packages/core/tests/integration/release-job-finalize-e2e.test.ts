/**
 * The two release-path functions the flow map names and the suites did not run
 * (ISS-863): the deploy dispatch that job completion triggers, and the CAS that
 * flips a job to `done`.
 *
 * `tryDispatchCoolifyRelease` carries `cm:flow release/deploy`, and
 * `check-flow-coverage.mjs` settles a step only from THIS suite — its six unit
 * describes cannot, which is why the step sat frozen in the baseline with the
 * function apparently well covered.
 *
 * `finalizeJobDone` was reachable only through `finalizeFailedJob`'s unit test,
 * where `lifecycle/transition.js` is mocked out — so the compare-and-set that
 * is the whole point of the function was asserted nowhere.
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

describe('release deploy dispatch and job finalize E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  async function openRun(status = 'running'): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${id}, ${projectId}, 'system', ${status}, '{}'::jsonb)
    `);
    return id;
  }

  async function seedProdBinding(): Promise<string> {
    const connectionId = randomUUID();
    const bindingId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (id, connection_id, project_id, provider, environment, active)
      VALUES (${bindingId}, ${connectionId}, ${projectId}, 'coolify', 'prod', true)
    `);
    return bindingId;
  }

  async function currentStep(runId: string): Promise<string | null> {
    const rows = await harness.db.execute(sql`
      SELECT current_step FROM pipeline_runs WHERE id = ${runId}
    `);
    return (rows[0]?.current_step as string | null) ?? null;
  }

  describe('tryDispatchCoolifyRelease', () => {
    it('skips and says so when the project has no Coolify binding at all', async () => {
      const { RELEASE_DEPLOY_SKIPPED, tryDispatchCoolifyRelease } = await import(
        '../../src/pipeline/release-coolify.js'
      );
      const runId = await openRun();

      const outcome = await tryDispatchCoolifyRelease({ projectId, issueId: null, runId });

      expect(outcome).toEqual({
        dispatched: false,
        pendingHumanConfirm: false,
        integrationIds: [],
        reason: 'no-integration',
      });
      // cm:guard the substep is the ONLY record that the deploy was considered and declined; without it a project with no integration is indistinguishable on the run from one whose dispatch silently failed
      expect(await currentStep(runId)).toBe(RELEASE_DEPLOY_SKIPPED);
    });

    // cm:guard prod is never auto-dispatched without `pipelineConfig.autoProdDeploy`, and the proof has to be that NOTHING was enqueued — asserting only the returned flag would pass against a version that parked the gate and deployed anyway
    it('parks a prod binding for a human instead of dispatching it', async () => {
      const { tryDispatchCoolifyRelease } = await import('../../src/pipeline/release-coolify.js');
      const bindingId = await seedProdBinding();
      const runId = await openRun();

      const outcome = await tryDispatchCoolifyRelease({ projectId, issueId: null, runId });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.pendingHumanConfirm).toBe(true);
      expect(outcome.integrationIds).toEqual([bindingId]);
      expect(outcome.reason).toBe('awaiting-prod-confirm');
      const deliveries = await harness.db.execute(sql`
        SELECT count(*)::int AS n FROM integration_deliveries WHERE binding_id = ${bindingId}
      `);
      expect(Number(deliveries[0]?.n ?? 0)).toBe(0);
    });

    // cm:guard `allowProd: false` is what the MCP deploy tool passes pre-release, and it must exclude prod BEFORE the confirm gate rather than by relying on it — a caller outside the release path has no gate to park against, so a prod binding reaching that branch would sit pending forever
    it('reports no integration when the only binding is prod and prod is not allowed', async () => {
      const { tryDispatchCoolifyRelease } = await import('../../src/pipeline/release-coolify.js');
      await seedProdBinding();
      const runId = await openRun();

      const outcome = await tryDispatchCoolifyRelease({
        projectId,
        issueId: null,
        runId,
        allowProd: false,
      });

      expect(outcome.reason).toBe('no-integration');
      expect(outcome.pendingHumanConfirm).toBe(false);
    });
  });

  describe('finalizeJobDone', () => {
    async function insertJob(status = 'running'): Promise<Record<string, unknown>> {
      const id = randomUUID();
      const runId = await openRun();
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload)
        VALUES (${id}, ${projectId}, NULL, ${runId}, ${ownerId}, 'release_batch', ${status}, '{}'::jsonb)
      `);
      const rows = await harness.db.execute(sql`SELECT * FROM jobs WHERE id = ${id}`);
      return rows[0] as Record<string, unknown>;
    }

    /** The drizzle row shape the function reads, built off the raw snake_case row. */
    function asJobRow(row: Record<string, unknown>) {
      return {
        id: row.id,
        projectId: row.project_id,
        issueId: row.issue_id,
        pipelineRunId: row.pipeline_run_id,
        type: row.type,
        status: row.status,
        agentSessionId: row.agent_session_id,
        dispatchedAt: row.dispatched_at,
        queuedAt: row.queued_at,
      } as never;
    }

    async function jobState(id: unknown): Promise<{ status: string; exitCode: unknown }> {
      const rows = await harness.db.execute(sql`
        SELECT status, exit_code FROM jobs WHERE id = ${id as string}
      `);
      return { status: String(rows[0]?.status), exitCode: rows[0]?.exit_code ?? null };
    }

    it('flips a running job to done with exit code 0', async () => {
      const { finalizeJobDone } = await import('../../src/jobs/finalize-done.js');
      const row = await insertJob('running');

      const flipped = await finalizeJobDone(asJobRow(row), 'completed_via_handoff');

      expect(flipped).toBe(true);
      expect(await jobState(row.id)).toEqual({ status: 'done', exitCode: 0 });
    });

    // cm:guard this is the whole reason the write is a CAS: two finalizers can observe the same job, and the one whose observed status is stale must LOSE rather than overwrite the terminal state the other wrote. Asserting only the `false` would pass against a version that returned false after writing.
    it('loses the race and writes nothing when the row moved since the caller read it', async () => {
      const { finalizeJobDone } = await import('../../src/jobs/finalize-done.js');
      const row = await insertJob('running');
      await harness.db.execute(sql`
        UPDATE jobs SET status = 'failed', exit_code = 1 WHERE id = ${row.id as string}
      `);

      const flipped = await finalizeJobDone(asJobRow(row), 'completed_via_handoff');

      expect(flipped).toBe(false);
      expect(await jobState(row.id)).toEqual({ status: 'failed', exitCode: 1 });
    });
  });
});
