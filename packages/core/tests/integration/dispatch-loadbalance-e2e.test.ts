/**
 * Load-balanced dispatch E2E (real Postgres). Covers the maxConcurrentIssues>1
 * fan-out path added on top of ISS-232:
 *   - selectRunnerForJob is LOAD-AWARE at cap>1: spills off a busy primary to a
 *     FREE standby (primary-first only when the primary itself is free), so two
 *     independent issues land on two hosts instead of piling onto the primary.
 *   - cap=1 is byte-for-byte the legacy primary-pinned path (busy primary still
 *     returned).
 *   - claimRunnerSlot is the authoritative, race-safe per-runner cap gate: it
 *     can NEVER let a runner exceed RUNNER_CAP_PER_RUNNER, even under concurrent
 *     dispatch of two jobs onto the same free runner.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  selectRunnerForJob: typeof import('../../src/runners/select.js').selectRunnerForJob;
  claimRunnerSlot: typeof import('../../src/jobs/dispatch-gates.js').claimRunnerSlot;
  countInFlightForRunner: typeof import('../../src/jobs/dispatch-gates.js').countInFlightForRunner;
};

describe('load-balanced dispatch E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const [sel, gates] = await Promise.all([
      import('../../src/runners/select.js'),
      import('../../src/jobs/dispatch-gates.js'),
    ]);
    mods = {
      selectRunnerForJob: sel.selectRunnerForJob,
      claimRunnerSlot: gates.claimRunnerSlot,
      countInFlightForRunner: gates.countInFlightForRunner,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });
  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---- seeding -----------------------------------------------------------
  async function project(cap?: number) {
    const owner = await createTestUser(harness.db);
    const p = await createTestProject(harness.db, owner.id);
    if (cap !== undefined) {
      await harness.db.execute(sql`
        UPDATE projects
        SET agent_config = jsonb_build_object('pipelineConfig', jsonb_build_object('maxConcurrentIssues', ${cap}::int))
        WHERE id = ${p.id}`);
    }
    return { owner, project: p };
  }
  async function device(ownerId: string): Promise<string> {
    const d = await createTestDevice(harness.db, ownerId, { status: 'online' });
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${d.id}`);
    return d.id;
  }
  async function runner(projectId: string, deviceId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (${id}, ${projectId}, 'claude-code', 'device', ${deviceId},
        ${`r-${id.slice(0, 8)}`}, '{}'::jsonb, 'online', now())`);
    return id;
  }
  async function setPrimary(projectId: string, deviceId: string): Promise<void> {
    await harness.db.execute(
      sql`UPDATE projects SET default_device_id = ${deviceId} WHERE id = ${projectId}`,
    );
  }
  async function busyJobOn(projectId: string, runnerId: string): Promise<string> {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${Math.floor(Math.random() * 1e6)}, 'busy', 'in_progress', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId}))`);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())`);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, runner_id, pipeline_run_id, payload, queued_at, dispatched_at, created_by)
      VALUES (${jobId}, ${projectId}, ${issueId}, 'code', 'running', ${runnerId}, ${runId},
        '{}'::jsonb, now(), now(), (SELECT created_by FROM projects WHERE id = ${projectId}))`);
    return jobId;
  }
  async function queuedJob(projectId: string): Promise<string> {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, ${Math.floor(Math.random() * 1e6)}, 'q', 'in_progress', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId}))`);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())`);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, pipeline_run_id, payload, queued_at, created_by)
      VALUES (${jobId}, ${projectId}, ${issueId}, 'code', 'queued', ${runId},
        '{}'::jsonb, now(), (SELECT created_by FROM projects WHERE id = ${projectId}))`);
    return jobId;
  }

  // ---- selectRunnerForJob: load-aware (cap>1) ----------------------------
  describe('selectRunnerForJob load-awareness', () => {
    it('cap>1: spills off a BUSY primary to the FREE standby', async () => {
      const { owner, project: p } = await project(2);
      const devP = await device(owner.id);
      const devS = await device(owner.id);
      const rP = await runner(p.id, devP);
      const rS = await runner(p.id, devS);
      await setPrimary(p.id, devP);
      await busyJobOn(p.id, rP); // primary at cap

      const chosen = await mods.selectRunnerForJob({
        projectId: p.id,
        requiredCapabilities: {},
        projectCap: 2,
      });
      expect(chosen?.id).toBe(rS); // free standby, NOT the busy primary
      expect(chosen?.id).not.toBe(rP);
    });

    it('cap>1: prefers the primary when the primary is FREE', async () => {
      const { owner, project: p } = await project(2);
      const devP = await device(owner.id);
      const devS = await device(owner.id);
      const rP = await runner(p.id, devP);
      await runner(p.id, devS);
      await setPrimary(p.id, devP);

      const chosen = await mods.selectRunnerForJob({
        projectId: p.id,
        requiredCapabilities: {},
        projectCap: 2,
      });
      expect(chosen?.id).toBe(rP); // primary-first on a tie
    });

    it('cap>1: returns null when every runner is full', async () => {
      const { owner, project: p } = await project(2);
      const devP = await device(owner.id);
      const devS = await device(owner.id);
      const rP = await runner(p.id, devP);
      const rS = await runner(p.id, devS);
      await setPrimary(p.id, devP);
      await busyJobOn(p.id, rP);
      await busyJobOn(p.id, rS);

      const chosen = await mods.selectRunnerForJob({
        projectId: p.id,
        requiredCapabilities: {},
        projectCap: 2,
      });
      expect(chosen).toBeNull();
    });

    it('cap>1: skips an excluded (e.g. tripped) primary device', async () => {
      const { owner, project: p } = await project(2);
      const devP = await device(owner.id);
      const devS = await device(owner.id);
      await runner(p.id, devP);
      const rS = await runner(p.id, devS);
      await setPrimary(p.id, devP);

      const chosen = await mods.selectRunnerForJob({
        projectId: p.id,
        requiredCapabilities: {},
        projectCap: 2,
        excludeDeviceIds: [devP],
      });
      expect(chosen?.id).toBe(rS);
    });

    it('cap=1 (default): legacy primary-pin — busy primary is still returned', async () => {
      const { owner, project: p } = await project(1);
      const devP = await device(owner.id);
      const devS = await device(owner.id);
      const rP = await runner(p.id, devP);
      await runner(p.id, devS);
      await setPrimary(p.id, devP);
      await busyJobOn(p.id, rP); // primary "full" but cap=1 path ignores capacity

      const chosen = await mods.selectRunnerForJob({
        projectId: p.id,
        requiredCapabilities: {},
        projectCap: 1,
      });
      expect(chosen?.id).toBe(rP); // unchanged legacy behaviour
    });
  });

  // ---- claimRunnerSlot: atomic per-runner cap ----------------------------
  describe('claimRunnerSlot', () => {
    it('claims a queued job onto a free runner', async () => {
      const { owner, project: p } = await project(2);
      const r = await runner(p.id, await device(owner.id));
      const j = await queuedJob(p.id);
      const res = await mods.claimRunnerSlot({ jobId: j, runnerId: r, deviceId: null, dispatchedAt: new Date() });
      expect(res).toBe('claimed');
      expect(await mods.countInFlightForRunner(r)).toBe(1);
    });

    it('returns runner_full when the runner is already at cap', async () => {
      const { owner, project: p } = await project(2);
      const r = await runner(p.id, await device(owner.id));
      await busyJobOn(p.id, r); // 1 in-flight = cap
      const j = await queuedJob(p.id);
      const res = await mods.claimRunnerSlot({ jobId: j, runnerId: r, deviceId: null, dispatchedAt: new Date() });
      expect(res).toBe('runner_full');
    });

    it('returns lost when the job is no longer queued', async () => {
      const { owner, project: p } = await project(2);
      const r = await runner(p.id, await device(owner.id));
      const j = await busyJobOn(p.id, r); // already running, not queued
      // free the slot conceptually by claiming on a DIFFERENT fresh runner
      const r2 = await runner(p.id, await device(owner.id));
      const res = await mods.claimRunnerSlot({ jobId: j, runnerId: r2, deviceId: null, dispatchedAt: new Date() });
      expect(res).toBe('lost');
    });

    it('two concurrent claims on the SAME free runner never exceed cap (one claimed, one full)', async () => {
      const { owner, project: p } = await project(2);
      const r = await runner(p.id, await device(owner.id));
      const j1 = await queuedJob(p.id);
      const j2 = await queuedJob(p.id);
      const [a, b] = await Promise.all([
        mods.claimRunnerSlot({ jobId: j1, runnerId: r, deviceId: null, dispatchedAt: new Date() }),
        mods.claimRunnerSlot({ jobId: j2, runnerId: r, deviceId: null, dispatchedAt: new Date() }),
      ]);
      const outcomes = [a, b].sort();
      expect(outcomes).toEqual(['claimed', 'runner_full']);
      expect(await mods.countInFlightForRunner(r)).toBe(1); // never 2
    });
  });
});
