/**
 * ISS-40 PR-E — dispatch-tick integration tests against real Postgres.
 *
 * Validates the per-project pick → tick → mark cycle that drives the
 * runtime sweep against the real schema.
 *
 * Heavy WS / runner-adapter / pg-boss layers are out of scope here; the
 * dispatcher-iss40-pipeline.test.ts file exercises the end-to-end loop.
 *
 * NOTE: the legacy 60s `dispatchTickAllProjectsWithQueued` backstop was
 * removed in ISS-196 (replaced by the outbox worker + reconciler). The
 * coverage that used to live here has moved to `outbox-worker.test.ts`
 * (unit) and is exercised in production by the trigger → outbox path.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type DTMods = {
  dispatchTickForProject: typeof import('../../src/jobs/dispatch-tick.js').dispatchTickForProject;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  setDispatchTickDebounceMs: typeof import('../../src/jobs/dispatch-tick.js').setDispatchTickDebounceMs;
};

describe('ISS-40 dispatch-tick E2E', () => {
  let harness: TestDatabase;
  let mods: DTMods;

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

    // Stub `handleDispatch` so we don't pull pg-boss / WS rooms / runner
    // adapter into the integration loop. We only assert that the tick picks
    // the right job and calls handleDispatch with the right id.
    vi.doMock('../../src/jobs/dispatcher.js', () => ({
      handleDispatch: vi.fn(async (_args: { jobId: string }) => 'dispatched'),
    }));

    mods = (await import('../../src/jobs/dispatch-tick.js')) as unknown as DTMods;
    mods.setDispatchTickDebounceMs(0);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---------- helpers ---------------------------------------------------

  async function seedProject() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    return { owner, project };
  }

  async function insertSession(
    projectId: string,
    args: { issueId?: string | null; status?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const metadata = args.issueId ? JSON.stringify({ issueId: args.issueId }) : '{}';
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, metadata)
      VALUES (${id}, ${projectId}, ${status}, ${metadata}::jsonb)
    `);
    return id;
  }

  async function insertPipelineRun(projectId: string, issueId?: string | null): Promise<string> {
    const id = randomUUID();
    const kind = issueId ? 'issue' : 'system';
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${issueId ?? null}, ${kind}, 'running', now())
    `);
    return id;
  }

  async function insertJob(
    projectId: string,
    args: { issueId?: string | null; status?: string; type?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const pipelineRunId = await insertPipelineRun(projectId, args.issueId ?? null);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, pipeline_run_id, created_by)
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${args.type ?? 'plan'},
        ${args.status ?? 'queued'}, '{}'::jsonb, ${pipelineRunId},
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function seedRunner(projectId: string, ownerId: string): Promise<string> {
    const { createTestDevice } = await import('../helpers/index.js');
    const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', 'device', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, '{}'::jsonb, 'online', now()
      )
    `);
    return runnerId;
  }

  async function insertIssue(projectId: string, issSeq = 0): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq + Math.floor(Math.random() * 100000)},
        ${'Issue'}, 'open',
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  // ---------- dispatchTickForProject (per-project sweep) ----------------

  describe('dispatchTickForProject (per-project sweep)', () => {
    it('picks the highest-priority queued job and dispatches it', async () => {
      const { owner, project } = await seedProject();
      await seedRunner(project.id, owner.id);

      // Insert two queued jobs with different priorities. The high-priority
      // job should be dispatched first.
      const lowIssue = await insertIssue(project.id);
      const highIssue = await insertIssue(project.id);
      await harness.db.execute(sql`
        UPDATE issues SET priority = 'low'      WHERE id = ${lowIssue};
      `);
      await harness.db.execute(sql`
        UPDATE issues SET priority = 'critical' WHERE id = ${highIssue};
      `);
      const lowJob = await insertJob(project.id, { issueId: lowIssue });
      const highJob = await insertJob(project.id, { issueId: highIssue });

      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();
      handleDispatch.mockImplementation(async (args: { jobId: string }) => {
        // Simulate dispatch by flipping the job to a terminal state so the
        // next tick iteration moves on instead of re-picking. Marking it
        // `done` (not `running`) also frees the project cap (hardcoded 1 in
        // ISS-232), so the lower-priority job on a *different* issue can be
        // picked next — proving both jobs eventually dispatch in priority order.
        await harness.db.execute(sql`
          UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${args.jobId}
        `);
        return 'dispatched';
      });

      await mods.dispatchTickForProject(project.id);

      const callOrder = handleDispatch.mock.calls.map((c) => (c[0] as { jobId: string }).jobId);
      expect(callOrder[0]).toBe(highJob);
      expect(callOrder).toContain(lowJob);
    });

    it('returns immediately when project has no queued jobs', async () => {
      const { project } = await seedProject();
      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();

      await mods.dispatchTickForProject(project.id);
      expect(handleDispatch).not.toHaveBeenCalled();
    });

    // The picker is stateless: a skipped candidate is EXCLUDED for the rest of
    // the tick (not re-picked) so the loop never spins, and ends when no other
    // placeable job remains. With a single stuck job that means exactly one
    // handleDispatch call, then the picker returns null.
    it('excludes a skipped job and does not re-pick it (no spin)', async () => {
      const { owner, project } = await seedProject();
      await seedRunner(project.id, owner.id);
      const issueId = await insertIssue(project.id);
      const stuck = await insertJob(project.id, { issueId });

      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();
      handleDispatch.mockResolvedValue('skipped');

      await mods.dispatchTickForProject(project.id);
      expect(handleDispatch).toHaveBeenCalledWith({ jobId: stuck });
      expect(handleDispatch).toHaveBeenCalledTimes(1);
    });

    // No head-of-line blocking: a job that cannot be placed (e.g. a resume
    // pinned to a busy host) must NOT end the tick — the next placeable job on
    // an independent issue still gets dispatched. Pre-fix, the first `skipped`
    // returned out of the loop and starved every following job.
    it('does not head-of-line block: a skipped job still lets a later job dispatch', async () => {
      const { owner, project } = await seedProject();
      await seedRunner(project.id, owner.id);
      const blockedIssue = await insertIssue(project.id);
      const readyIssue = await insertIssue(project.id);
      // Pick order: make the unplaceable one go first.
      await harness.db.execute(sql`UPDATE issues SET priority = 'critical' WHERE id = ${blockedIssue}`);
      await harness.db.execute(sql`UPDATE issues SET priority = 'low'      WHERE id = ${readyIssue}`);
      const blockedJob = await insertJob(project.id, { issueId: blockedIssue });
      const readyJob = await insertJob(project.id, { issueId: readyIssue });

      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();
      handleDispatch.mockImplementation(async (args: { jobId: string }) => {
        if (args.jobId === blockedJob) return 'skipped'; // unplaceable
        await harness.db.execute(sql`
          UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${args.jobId}`);
        return 'dispatched';
      });

      await mods.dispatchTickForProject(project.id);

      const calls = handleDispatch.mock.calls.map((c) => (c[0] as { jobId: string }).jobId);
      expect(calls[0]).toBe(blockedJob); // critical-priority, tried first
      expect(calls).toContain(readyJob); // still dispatched despite the skip
    });
  });
});
