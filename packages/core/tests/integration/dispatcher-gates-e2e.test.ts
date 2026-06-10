/**
 * ISS-162 — Stateless Gates picker integration tests against real Postgres.
 *
 * The picker now evaluates L1/L2/L3 inline via a single SQL statement. This
 * suite seeds realistic project state and asserts the picker returns the
 * right candidate (or null) in each scenario. L4 (runner_full) keeps its
 * own dedicated coverage because it is evaluated post-pick in the dispatcher.
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
  checkLayer4RunnerFull: typeof import('../../src/jobs/dispatch-gates.js').checkLayer4RunnerFull;
  countInFlightForRunner: typeof import('../../src/jobs/dispatch-gates.js').countInFlightForRunner;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  pickNextDispatchableJobForProject: typeof import('../../src/jobs/dispatch-gates.js').pickNextDispatchableJobForProject;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  DEFAULT_MAX_CONCURRENT_ISSUES: typeof import('../../src/jobs/dispatch-gates.js').DEFAULT_MAX_CONCURRENT_ISSUES;
};

describe('ISS-162 stateless-gates picker E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;

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

    mods = (await import('../../src/jobs/dispatch-gates.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---------- helpers ---------------------------------------------------

  async function seedProject(opts?: { maxConcurrentIssues?: number }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    if (opts?.maxConcurrentIssues !== undefined) {
      const cap = opts.maxConcurrentIssues;
      await harness.db.execute(sql`
        UPDATE projects
        SET agent_config = COALESCE(agent_config, '{}'::jsonb)
                         || jsonb_build_object(
                              'pipelineConfig',
                              COALESCE(agent_config -> 'pipelineConfig', '{}'::jsonb)
                                || jsonb_build_object('maxConcurrentIssues', ${cap}::int))
        WHERE id = ${project.id}
      `);
    }
    return { owner, project };
  }

  async function insertIssue(
    projectId: string,
    overrides: { status?: string; priority?: string; issSeq?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? 'open';
    const priority = overrides.priority ?? 'medium';
    const issSeq = overrides.issSeq ?? Math.floor(Math.random() * 100000);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, ${status}, ${priority},
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertSession(
    projectId: string,
    args: { issueId?: string | null; status?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const metadata = args.issueId ? JSON.stringify({ issueId: args.issueId }) : '{}';
    const pipelineRunId = await insertPipelineRun(projectId, args.issueId ?? null);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, metadata, pipeline_run_id)
      VALUES (${id}, ${projectId}, ${status}, ${metadata}::jsonb, ${pipelineRunId})
    `);
    return id;
  }

  async function insertPipelineRun(projectId: string, issueId?: string | null): Promise<string> {
    // At most one OPEN issue-run per issue (`pipeline_runs_issue_open_uq`).
    // A session + the job for the same issue must therefore SHARE one run —
    // reuse the existing open run if present, otherwise insert a fresh one.
    if (issueId) {
      const existing = await harness.db.execute<{ id: string }>(sql`
        SELECT id FROM pipeline_runs
        WHERE issue_id = ${issueId} AND kind = 'issue' AND status IN ('running','paused')
        LIMIT 1
      `);
      if (existing[0]?.id) return existing[0].id;
    }
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
    args: {
      issueId?: string | null;
      status?: string;
      runnerId?: string | null;
      type?: string;
      priority?: string;
      queuedAt?: Date;
      agentSessionId?: string | null;
      pipelineRunId?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const type = args.type ?? 'plan';
    const queuedAt = args.queuedAt ?? new Date();
    const pipelineRunId =
      args.pipelineRunId ?? (await insertPipelineRun(projectId, args.issueId ?? null));
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, runner_id,
        agent_session_id, pipeline_run_id, payload, queued_at,
        created_by
      )
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${type}, ${status},
        ${args.runnerId ?? null}, ${args.agentSessionId ?? null}, ${pipelineRunId},
        '{}'::jsonb, ${queuedAt.toISOString()},
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertRunner(
    projectId: string,
    deviceId: string,
    args: { type?: 'claude-code' | 'antigravity'; maxConcurrent?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const type = args.type ?? 'claude-code';
    const caps = args.maxConcurrent != null ? { maxConcurrent: args.maxConcurrent } : {};
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status)
      VALUES (
        ${id}, ${projectId}, ${type}, 'device', ${deviceId}, ${`runner-${id.slice(0, 8)}`},
        ${JSON.stringify(caps)}::jsonb, 'online'
      )
    `);
    return id;
  }

  // Picker requires a FRESH capable runner (EXISTS fresh_capable_runners
  // WHERE in_flight < cap). Seed an online claude-code runner with a fresh
  // last_seen_at so any positive-pick assertion isn't starved by L4/L5.
  async function seedFreshRunner(projectId: string, ownerId: string): Promise<string> {
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

  async function insertBlocksEdge(
    projectId: string,
    fromIssueId: string,
    toIssueId: string,
    opts: { validUntil?: Date | null; kind?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const kind = opts.kind ?? 'blocks';
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (
        ${id}, ${projectId}, ${fromIssueId}, ${toIssueId}, ${kind},
        ${opts.validUntil === undefined ? null : (opts.validUntil?.toISOString() ?? null)}
      )
    `);
    return id;
  }

  // ---------- L4 — runner_full (post-pick) ------------------------------

  describe('Layer 4 — runner_full', () => {
    it('passes when no jobs are in-flight on the runner', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { maxConcurrent: 2 });
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(true);
    });

    it('fails when in-flight jobs reach the runner cap', async () => {
      // ISS-232 — runner cap is hardcoded to 1; one in-flight job fills it.
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id);
      await insertJob(project.id, { runnerId, status: 'running' });
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.reason).toBe('runner_full');
        expect(result.metadata).toMatchObject({ cap: 1, inFlight: 1 });
      }
    });

    it('respects excludeJobId so the candidate itself is not counted', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { maxConcurrent: 1 });
      const jobId = await insertJob(project.id, { runnerId, status: 'dispatched' });
      const result = await mods.checkLayer4RunnerFull(runnerId, { excludeJobId: jobId });
      expect(result.pass).toBe(true);
    });

    it('passes (gracefully) when runner row no longer exists', async () => {
      const result = await mods.checkLayer4RunnerFull(randomUUID());
      expect(result.pass).toBe(true);
    });

    it('countInFlightForRunner counts dispatched + running rows', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id);
      await insertJob(project.id, { runnerId, status: 'dispatched' });
      await insertJob(project.id, { runnerId, status: 'running' });
      await insertJob(project.id, { runnerId, status: 'queued' });
      await insertJob(project.id, { runnerId, status: 'completed' });
      const count = await mods.countInFlightForRunner(runnerId);
      expect(count).toBe(2);
    });
  });

  // ---------- pickNextDispatchableJobForProject (inline L1/L2/L3) -------

  describe('pickNextDispatchableJobForProject', () => {
    it('returns null when no queued jobs exist', async () => {
      const { project } = await seedProject();
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
    });

    it('orders by priority (critical>high>medium>low>none), then run.started_at, then queued_at ASC', async () => {
      const { owner, project } = await seedProject({ maxConcurrentIssues: 10 });
      await seedFreshRunner(project.id, owner.id);
      const i1 = await insertIssue(project.id, { priority: 'low', issSeq: 71 });
      const i2 = await insertIssue(project.id, { priority: 'critical', issSeq: 72 });
      const i3 = await insertIssue(project.id, { priority: 'high', issSeq: 73 });
      await insertJob(project.id, { issueId: i1, queuedAt: new Date(Date.now() - 60_000) });
      const j2 = await insertJob(project.id, {
        issueId: i2,
        queuedAt: new Date(Date.now() - 30_000),
      });
      await insertJob(project.id, { issueId: i3, queuedAt: new Date(Date.now() - 10_000) });

      const first = await mods.pickNextDispatchableJobForProject(project.id);
      expect(first?.id).toBe(j2);
    });

    it('skips jobs whose blocking parent is non-terminal (L2 blocks inline)', async () => {
      const { owner, project } = await seedProject({ maxConcurrentIssues: 10 });
      await seedFreshRunner(project.id, owner.id);
      const parent = await insertIssue(project.id, { status: 'in_progress' });
      const blocked = await insertIssue(project.id);
      const free = await insertIssue(project.id);
      await insertBlocksEdge(project.id, parent, blocked);
      await insertJob(project.id, { issueId: blocked });
      const jFree = await insertJob(project.id, { issueId: free });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result?.id).toBe(jFree);
    });

    it('skips jobs whose issue has an active sibling session (L1 inline)', async () => {
      const { owner, project } = await seedProject({ maxConcurrentIssues: 10 });
      await seedFreshRunner(project.id, owner.id);
      const busy = await insertIssue(project.id);
      const free = await insertIssue(project.id);
      // Active session for `busy` without linking to the candidate job — the
      // picker's NOT EXISTS clause matches via metadata->>'issueId'.
      await insertSession(project.id, { issueId: busy, status: 'running' });
      await insertJob(project.id, { issueId: busy });
      const jFree = await insertJob(project.id, { issueId: free });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result?.id).toBe(jFree);
    });

    it('skips when project is at maxConcurrentIssues cap (L3 inline)', async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 1 });
      const busy = await insertIssue(project.id, { issSeq: 81 });
      const waiting = await insertIssue(project.id, { issSeq: 82 });
      // One issue is running; cap=1; the waiting candidate should be filtered.
      await insertSession(project.id, { issueId: busy, status: 'running' });
      await insertJob(project.id, { issueId: waiting });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
    });

    it('does not block a candidate whose own issue is already counted toward the cap (L3 self-exclusion)', async () => {
      const { owner, project } = await seedProject({ maxConcurrentIssues: 1 });
      await seedFreshRunner(project.id, owner.id);
      const single = await insertIssue(project.id);
      // The candidate's issue already has a queued session — Layer 1 would
      // normally catch that, but here we use a `completed` placeholder so
      // L1 passes and only the L3 self-exclusion matters.
      await insertSession(project.id, { issueId: single, status: 'completed' });
      const j = await insertJob(project.id, { issueId: single });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result?.id).toBe(j);
    });

    it("blocks a decompose PARENT's forward job until its children terminate (L2 decompose inline)", async () => {
      // Decompose redesign — the PARENT runs its integration LAST. The
      // dependency is one-directional now: a parent's code/review/test/fix
      // job waits for every `kind='decomposes'` child to land (merged_at set
      // OR closed). Children are NOT gated on the parent (the old
      // releaseDecomposePending gate was removed — it deadlocked umbrella
      // epics that never code-merge themselves).
      const { owner, project } = await seedProject({ maxConcurrentIssues: 10 });
      await seedFreshRunner(project.id, owner.id);
      const parent = await insertIssue(project.id, { status: 'approved', issSeq: 91 });
      const child = await insertIssue(project.id, { status: 'developed', issSeq: 92 });
      await insertBlocksEdge(project.id, parent, child, { kind: 'decomposes' });
      const parentCode = await insertJob(project.id, { issueId: parent, type: 'code' });
      // While the child is non-terminal, the parent's code job is filtered.
      let result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
      // Close the child — parent's code job becomes pickable.
      await harness.db.execute(sql`UPDATE issues SET status='closed' WHERE id=${child}`);
      result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result?.id).toBe(parentCode);
    });

    it('skips PM jobs (`type=pm`)', async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 10 });
      const issueId = await insertIssue(project.id);
      await insertJob(project.id, { type: 'pm', issueId });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
    });
  });
});
