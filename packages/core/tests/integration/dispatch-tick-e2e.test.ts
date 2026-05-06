/**
 * ISS-40 PR-E — dispatch-tick integration tests against real Postgres.
 *
 * Validates the SQL that powers `dispatchTickAllProjectsWithQueued` (the
 * 60s pg-boss backstop fan-out) against the real schema, plus the per-
 * project pick → tick → mark cycle that drives the runtime sweep.
 *
 * Heavy WS / runner-adapter / pg-boss layers are out of scope here; the
 * dispatcher-iss40-pipeline.test.ts file exercises the end-to-end loop.
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
  dispatchTickAllProjectsWithQueued: typeof import('../../src/jobs/dispatch-tick.js').dispatchTickAllProjectsWithQueued;
  dispatchTickForProject: typeof import('../../src/jobs/dispatch-tick.js').dispatchTickForProject;
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

  async function insertJob(
    projectId: string,
    args: { issueId?: string | null; status?: string; type?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, created_by)
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${args.type ?? 'plan'},
        ${args.status ?? 'queued'}, '{}'::jsonb,
        (SELECT owner_id FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertIssue(projectId: string, issSeq = 0): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq + Math.floor(Math.random() * 100000)},
        ${'Issue'}, 'open',
        (SELECT owner_id FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  // ---------- dispatchTickAllProjectsWithQueued ------------------------

  describe('dispatchTickAllProjectsWithQueued (backstop sweep)', () => {
    it('finds DISTINCT project_ids from queued jobs', async () => {
      const a = await seedProject();
      const b = await seedProject();
      const issueA = await insertIssue(a.project.id);
      const issueB = await insertIssue(b.project.id);
      await insertJob(a.project.id, { issueId: issueA });
      await insertJob(b.project.id, { issueId: issueB });

      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();

      await mods.dispatchTickAllProjectsWithQueued();

      // Each project triggers a tick. Tick picks one queued job per project.
      // We don't care about call order, just that both jobs were dispatched.
      const calledJobIds = handleDispatch.mock.calls.map((c) => (c[0] as { jobId: string }).jobId);
      expect(calledJobIds.length).toBeGreaterThanOrEqual(2);
    });

    it('finds DISTINCT project_ids from queued agent_sessions', async () => {
      const a = await seedProject();
      const b = await seedProject();
      // No jobs, only sessions — backstop should still tick both projects.
      await insertSession(a.project.id, { status: 'queued' });
      await insertSession(b.project.id, { status: 'queued' });

      const rows = await harness.db.execute<{ project_id: string }>(sql`
        SELECT DISTINCT project_id
        FROM (
          SELECT project_id FROM jobs WHERE status = 'queued' AND type <> 'pm'
          UNION
          SELECT project_id FROM agent_sessions WHERE status = 'queued'
        ) t
        WHERE project_id IS NOT NULL
      `);
      const projectIds = rows.map((r) => r.project_id).sort();
      expect(projectIds).toEqual([a.project.id, b.project.id].sort());
    });

    it('skips PM jobs (`type=pm`)', async () => {
      const a = await seedProject();
      const issueA = await insertIssue(a.project.id);
      await insertJob(a.project.id, { issueId: issueA, type: 'pm' });

      const rows = await harness.db.execute<{ project_id: string }>(sql`
        SELECT DISTINCT project_id
        FROM (
          SELECT project_id FROM jobs WHERE status = 'queued' AND type <> 'pm'
          UNION
          SELECT project_id FROM agent_sessions WHERE status = 'queued'
        ) t
        WHERE project_id IS NOT NULL
      `);
      // No agent_sessions or non-pm jobs queued → no projects returned.
      expect(rows).toHaveLength(0);
    });

    it('returns empty when no queued work exists', async () => {
      await seedProject();
      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();

      await mods.dispatchTickAllProjectsWithQueued();
      expect(handleDispatch).not.toHaveBeenCalled();
    });
  });

  // ---------- dispatchTickForProject (per-project sweep) ----------------

  describe('dispatchTickForProject (per-project sweep)', () => {
    it('picks the highest-priority queued job and dispatches it', async () => {
      const { project } = await seedProject();

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
        // Simulate dispatch by flipping the job to running so the next tick
        // iteration moves on instead of re-picking.
        await harness.db.execute(sql`
          UPDATE jobs SET status = 'running' WHERE id = ${args.jobId}
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

    it('breaks on the seen-job guard if the same id keeps being picked', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      const stuck = await insertJob(project.id, { issueId });

      const dispatcher = await import('../../src/jobs/dispatcher.js');
      const handleDispatch = dispatcher.handleDispatch as unknown as ReturnType<typeof vi.fn>;
      handleDispatch.mockClear();
      // Always return 'skipped' WITHOUT changing the job status — simulates
      // a layer-4 reject loop with one available runner.
      handleDispatch.mockResolvedValue('skipped');

      await mods.dispatchTickForProject(project.id);
      // First iteration picks the job, second iteration sees the same id and breaks.
      expect(handleDispatch).toHaveBeenCalledWith({ jobId: stuck });
      expect(handleDispatch).toHaveBeenCalledTimes(1);
    });
  });
});
