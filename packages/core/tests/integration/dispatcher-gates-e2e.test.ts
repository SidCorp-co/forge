/**
 * ISS-40 PR-E — gate-helper integration tests against real Postgres.
 *
 * The unit tests under `src/jobs/dispatch-gates.test.ts` mock `db` and assert
 * the threshold/reason mapping logic. This suite validates the SQL itself —
 * jsonb path expressions, the priority CASE ordering, the `NOT EXISTS`
 * subquery for deps satisfaction, and the partial-index filter shapes — by
 * hitting the real schema + migrations.
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
  checkLayer1IssueBusy: typeof import('../../src/jobs/dispatch-gates.js').checkLayer1IssueBusy;
  checkLayer2Dependencies: typeof import('../../src/jobs/dispatch-gates.js').checkLayer2Dependencies;
  checkLayer3ProjectFull: typeof import('../../src/jobs/dispatch-gates.js').checkLayer3ProjectFull;
  checkLayer4RunnerFull: typeof import('../../src/jobs/dispatch-gates.js').checkLayer4RunnerFull;
  countInFlightForRunner: typeof import('../../src/jobs/dispatch-gates.js').countInFlightForRunner;
  pickNextDispatchableJobForProject: typeof import('../../src/jobs/dispatch-gates.js').pickNextDispatchableJobForProject;
  markSessionGated: typeof import('../../src/jobs/dispatch-gates.js').markSessionGated;
  DEFAULT_MAX_CONCURRENT_ISSUES: typeof import('../../src/jobs/dispatch-gates.js').DEFAULT_MAX_CONCURRENT_ISSUES;
};

describe('ISS-40 dispatch-gates E2E', () => {
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
      // Mirror migration 0044's deep-merge so intermediate keys are created.
      // The literal cast is required so postgres can infer the jsonb_build_object
      // value type (bound parameters have unknown type otherwise).
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
        ${id}, ${projectId}, ${issSeq}, ${'Issue ' + issSeq}, ${status}, ${priority},
        (SELECT owner_id FROM projects WHERE id = ${projectId})
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
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, metadata)
      VALUES (${id}, ${projectId}, ${status}, ${metadata}::jsonb)
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
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const type = args.type ?? 'plan';
    const queuedAt = args.queuedAt ?? new Date();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, runner_id,
        agent_session_id, payload, queued_at,
        created_by
      )
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${type}, ${status},
        ${args.runnerId ?? null}, ${args.agentSessionId ?? null},
        '{}'::jsonb, ${queuedAt.toISOString()},
        (SELECT owner_id FROM projects WHERE id = ${projectId})
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
        ${id}, ${projectId}, ${type}, 'device', ${deviceId}, ${'runner-' + id.slice(0, 8)},
        ${JSON.stringify(caps)}::jsonb, 'online'
      )
    `);
    return id;
  }

  async function insertBlocksEdge(
    projectId: string,
    fromIssueId: string,
    toIssueId: string,
    opts: { validUntil?: Date | null } = {},
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (
        ${id}, ${projectId}, ${fromIssueId}, ${toIssueId}, 'blocks',
        ${opts.validUntil === undefined ? null : (opts.validUntil?.toISOString() ?? null)}
      )
    `);
    return id;
  }

  // ---------- Layer 1 — issue_busy --------------------------------------

  describe('Layer 1 — issue_busy', () => {
    it('passes when no other session is active for this issue', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      const result = await mods.checkLayer1IssueBusy(issueId);
      expect(result.pass).toBe(true);
    });

    it('fails when another running session shares the same issueId', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertSession(project.id, { issueId, status: 'running' });
      const result = await mods.checkLayer1IssueBusy(issueId);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.reason).toBe('issue_busy');
      }
    });

    it('fails when a queued session shares the same issueId', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertSession(project.id, { issueId, status: 'queued' });
      const result = await mods.checkLayer1IssueBusy(issueId);
      expect(result.pass).toBe(false);
    });

    it('fails when an in-flight job exists for the same issueId', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertJob(project.id, { issueId, status: 'running' });
      const result = await mods.checkLayer1IssueBusy(issueId);
      expect(result.pass).toBe(false);
    });

    it('respects excludeJobId so the candidate itself is not counted', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      const jobId = await insertJob(project.id, { issueId, status: 'running' });
      const result = await mods.checkLayer1IssueBusy(issueId, { excludeJobId: jobId });
      expect(result.pass).toBe(true);
    });

    it('passes when sessions are completed/failed (not active)', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertSession(project.id, { issueId, status: 'completed' });
      await insertSession(project.id, { issueId, status: 'failed' });
      const result = await mods.checkLayer1IssueBusy(issueId);
      expect(result.pass).toBe(true);
    });
  });

  // ---------- Layer 2 — waiting_on_dep ----------------------------------

  describe('Layer 2 — waiting_on_dep', () => {
    it('passes when issue has no blocking parents', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      const result = await mods.checkLayer2Dependencies(issueId);
      expect(result.pass).toBe(true);
    });

    it('fails when a single blocking parent is in_progress', async () => {
      const { project } = await seedProject();
      const parent = await insertIssue(project.id, { status: 'in_progress', issSeq: 12 });
      const child = await insertIssue(project.id, { status: 'open', issSeq: 13 });
      await insertBlocksEdge(project.id, parent, child);
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.reason).toBe('waiting_on_dep');
        const waitingOn = (result.metadata?.waitingOn ?? []) as Array<{
          issueId: string;
          issSeq: number;
        }>;
        expect(waitingOn).toHaveLength(1);
        expect(waitingOn[0]?.issueId).toBe(parent);
      }
    });

    it('passes when the only blocking parent reaches a terminal status', async () => {
      const { project } = await seedProject();
      const parent = await insertIssue(project.id, { status: 'closed' });
      const child = await insertIssue(project.id);
      await insertBlocksEdge(project.id, parent, child);
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(true);
    });

    it('treats `released` and `pipeline_failed` as terminal too', async () => {
      const { project } = await seedProject();
      const released = await insertIssue(project.id, { status: 'released', issSeq: 21 });
      const failed = await insertIssue(project.id, { status: 'pipeline_failed', issSeq: 22 });
      const child = await insertIssue(project.id, { issSeq: 23 });
      await insertBlocksEdge(project.id, released, child);
      await insertBlocksEdge(project.id, failed, child);
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(true);
    });

    it('fails when ANY of multiple parents is non-terminal', async () => {
      const { project } = await seedProject();
      const a1 = await insertIssue(project.id, { status: 'closed', issSeq: 31 });
      const a2 = await insertIssue(project.id, { status: 'in_progress', issSeq: 32 });
      const child = await insertIssue(project.id, { issSeq: 33 });
      await insertBlocksEdge(project.id, a1, child);
      await insertBlocksEdge(project.id, a2, child);
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        const waitingOn = (result.metadata?.waitingOn ?? []) as Array<{ issueId: string }>;
        expect(waitingOn.map((w) => w.issueId)).toEqual([a2]);
      }
    });

    it('ignores edges with `valid_until` in the past', async () => {
      const { project } = await seedProject();
      const parent = await insertIssue(project.id, { status: 'in_progress' });
      const child = await insertIssue(project.id);
      await insertBlocksEdge(project.id, parent, child, {
        validUntil: new Date(Date.now() - 60_000),
      });
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(true);
    });

    it('honors edges with `valid_until` in the future', async () => {
      const { project } = await seedProject();
      const parent = await insertIssue(project.id, { status: 'in_progress' });
      const child = await insertIssue(project.id);
      await insertBlocksEdge(project.id, parent, child, {
        validUntil: new Date(Date.now() + 60_000),
      });
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(false);
    });

    it('only enforces `kind=blocks` (relates/duplicates/parent are PM metadata)', async () => {
      const { project } = await seedProject();
      const related = await insertIssue(project.id, { status: 'in_progress', issSeq: 41 });
      const child = await insertIssue(project.id, { issSeq: 42 });
      // Insert a non-`blocks` edge
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
        VALUES (${id}, ${project.id}, ${related}, ${child}, 'relates')
      `);
      const result = await mods.checkLayer2Dependencies(child);
      expect(result.pass).toBe(true);
    });

    // ISS-131 — sibling-blocks chain. Reproduces the ISS-121 dogfood
    // failure mode at the gate level: A blocks B blocks C, all `approved`.
    // Until A reaches a terminal status, B and C must both park with
    // `waiting_on_dep`. After A flips to `released`, B unblocks but C
    // still waits on B.
    it('parks every downstream link of a sibling-blocks chain until the head terminates', async () => {
      const { project } = await seedProject();
      const a = await insertIssue(project.id, { status: 'approved', issSeq: 121 });
      const b = await insertIssue(project.id, { status: 'approved', issSeq: 122 });
      const c = await insertIssue(project.id, { status: 'approved', issSeq: 123 });
      await insertBlocksEdge(project.id, a, b);
      await insertBlocksEdge(project.id, b, c);

      // Head dispatches freely; both descendants are parked across the
      // 7 pipeline job types so a future single-jobType regression cannot
      // silently let a chain leak through.
      const headResult = await mods.checkLayer2Dependencies(a, 'triage');
      expect(headResult.pass).toBe(true);

      for (const jobType of [
        'triage',
        'plan',
        'code',
        'review',
        'test',
        'fix',
        'release',
      ] as const) {
        const middle = await mods.checkLayer2Dependencies(b, jobType);
        expect(middle.pass, `B/${jobType} should be parked`).toBe(false);
        if (!middle.pass) expect(middle.reason).toBe('waiting_on_dep');

        const tail = await mods.checkLayer2Dependencies(c, jobType);
        expect(tail.pass, `C/${jobType} should be parked`).toBe(false);
        if (!tail.pass) expect(tail.reason).toBe('waiting_on_dep');
      }

      // Flip A to released — B unblocks, C still waits on B.
      await harness.db.execute(sql`UPDATE issues SET status = 'released' WHERE id = ${a}`);
      const bAfter = await mods.checkLayer2Dependencies(b, 'triage');
      expect(bAfter.pass).toBe(true);
      const cAfter = await mods.checkLayer2Dependencies(c, 'triage');
      expect(cAfter.pass).toBe(false);
      if (!cAfter.pass) expect(cAfter.reason).toBe('waiting_on_dep');
    });
  });

  // ---------- Layer 3 — project_full ------------------------------------

  describe('Layer 3 — project_full', () => {
    it('passes when no other issues are running', async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 2 });
      const candidate = await insertIssue(project.id);
      const result = await mods.checkLayer3ProjectFull(project.id, candidate);
      expect(result.pass).toBe(true);
    });

    it('fails when DISTINCT running issue count meets the cap', async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 2 });
      const a = await insertIssue(project.id, { issSeq: 51 });
      const b = await insertIssue(project.id, { issSeq: 52 });
      const candidate = await insertIssue(project.id, { issSeq: 53 });
      await insertSession(project.id, { issueId: a, status: 'running' });
      await insertSession(project.id, { issueId: b, status: 'running' });
      const result = await mods.checkLayer3ProjectFull(project.id, candidate);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.reason).toBe('project_full');
        expect(result.metadata).toMatchObject({ cap: 2, running: 2 });
      }
    });

    it('counts DISTINCT issueIds, not total session count', async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 2 });
      const a = await insertIssue(project.id, { issSeq: 61 });
      const candidate = await insertIssue(project.id, { issSeq: 62 });
      // Three sessions, but only one distinct issueId.
      await insertSession(project.id, { issueId: a, status: 'running' });
      await insertSession(project.id, { issueId: a, status: 'queued' });
      await insertSession(project.id, { issueId: a, status: 'running' });
      const result = await mods.checkLayer3ProjectFull(project.id, candidate);
      expect(result.pass).toBe(true);
    });

    it("excludes the candidate's own issueId from the count", async () => {
      const { project } = await seedProject({ maxConcurrentIssues: 1 });
      const candidate = await insertIssue(project.id);
      // The candidate's issue already has a queued session — Layer 1 catches
      // that, but Layer 3 should not double-count it as "another issue".
      await insertSession(project.id, { issueId: candidate, status: 'queued' });
      const result = await mods.checkLayer3ProjectFull(project.id, candidate);
      expect(result.pass).toBe(true);
    });

    it('falls back to DEFAULT_MAX_CONCURRENT_ISSUES when project agent_config is missing', async () => {
      const { project } = await seedProject(); // no override
      // Migration 0044 backfills 3, but the seed factory may run before the
      // migration's UPDATE on a fresh schema — mirror that by clearing the
      // override the factory would have set.
      await harness.db.execute(sql`
        UPDATE projects
        SET agent_config = NULL
        WHERE id = ${project.id}
      `);
      const issues: string[] = [];
      for (let i = 0; i < mods.DEFAULT_MAX_CONCURRENT_ISSUES; i++) {
        const issueId = await insertIssue(project.id, { issSeq: 100 + i });
        await insertSession(project.id, { issueId, status: 'running' });
        issues.push(issueId);
      }
      const candidate = await insertIssue(project.id, { issSeq: 999 });
      const result = await mods.checkLayer3ProjectFull(project.id, candidate);
      expect(result.pass).toBe(false);
    });
  });

  // ---------- Layer 4 — runner_full -------------------------------------

  describe('Layer 4 — runner_full', () => {
    it('passes when no jobs are in-flight on the runner', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { maxConcurrent: 2 });
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(true);
    });

    it('fails when in-flight jobs reach the runner cap', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { maxConcurrent: 2 });
      await insertJob(project.id, { runnerId, status: 'running' });
      await insertJob(project.id, { runnerId, status: 'dispatched' });
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(false);
      if (!result.pass) {
        expect(result.reason).toBe('runner_full');
        expect(result.metadata).toMatchObject({ cap: 2, inFlight: 2 });
      }
    });

    it('uses the claude-code default cap (2) when capabilities.maxConcurrent is unset', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { type: 'claude-code' });
      await insertJob(project.id, { runnerId, status: 'running' });
      await insertJob(project.id, { runnerId, status: 'running' });
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(false);
    });

    it('uses the antigravity default cap (5) when capabilities.maxConcurrent is unset', async () => {
      const { owner, project } = await seedProject();
      const device = await createTestDevice(harness.db, owner.id);
      const runnerId = await insertRunner(project.id, device.id, { type: 'antigravity' });
      // 4 in-flight jobs — under the 5-cap default.
      for (let i = 0; i < 4; i++) {
        await insertJob(project.id, { runnerId, status: 'running' });
      }
      const result = await mods.checkLayer4RunnerFull(runnerId);
      expect(result.pass).toBe(true);
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
      await insertJob(project.id, { runnerId, status: 'queued' }); // not counted
      await insertJob(project.id, { runnerId, status: 'completed' }); // not counted
      const count = await mods.countInFlightForRunner(runnerId);
      expect(count).toBe(2);
    });
  });

  // ---------- pickNextDispatchableJobForProject -------------------------

  describe('pickNextDispatchableJobForProject', () => {
    it('returns null when no queued jobs exist', async () => {
      const { project } = await seedProject();
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
    });

    it('orders by priority (critical>high>medium>low>none), then queued_at ASC', async () => {
      const { project } = await seedProject();
      const i1 = await insertIssue(project.id, { priority: 'low', issSeq: 71 });
      const i2 = await insertIssue(project.id, { priority: 'critical', issSeq: 72 });
      const i3 = await insertIssue(project.id, { priority: 'high', issSeq: 73 });
      // i1 queued earliest; i2 is critical so should win.
      const j1 = await insertJob(project.id, {
        issueId: i1,
        queuedAt: new Date(Date.now() - 60_000),
      });
      const j2 = await insertJob(project.id, {
        issueId: i2,
        queuedAt: new Date(Date.now() - 30_000),
      });
      const _j3 = await insertJob(project.id, {
        issueId: i3,
        queuedAt: new Date(Date.now() - 10_000),
      });

      const first = await mods.pickNextDispatchableJobForProject(project.id);
      expect(first?.id).toBe(j2);
      // After flipping j2 to running, the next pick should be the high-priority one.
      await harness.db.execute(sql`UPDATE jobs SET status = 'running' WHERE id = ${j2}`);
      const second = await mods.pickNextDispatchableJobForProject(project.id);
      expect(second?.id).not.toBe(j1);
    });

    it('skips jobs whose blocking parent is non-terminal', async () => {
      const { project } = await seedProject();
      const parent = await insertIssue(project.id, { status: 'in_progress' });
      const blocked = await insertIssue(project.id);
      const free = await insertIssue(project.id);
      await insertBlocksEdge(project.id, parent, blocked);
      const _jBlocked = await insertJob(project.id, { issueId: blocked });
      const jFree = await insertJob(project.id, { issueId: free });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result?.id).toBe(jFree);
    });

    it('skips PM jobs (`type=pm`)', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertJob(project.id, { type: 'pm', issueId });
      const result = await mods.pickNextDispatchableJobForProject(project.id);
      expect(result).toBeNull();
    });
  });

  // ---------- markSessionGated ------------------------------------------

  describe('markSessionGated', () => {
    it('writes failureReason onto the session linked via job.agentSessionId', async () => {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      const sessionId = await insertSession(project.id, { issueId });
      const jobId = await insertJob(project.id, { issueId, agentSessionId: sessionId });
      await mods.markSessionGated(jobId, 'project_full', 'cap=2', { cap: 2, running: 2 });
      const [row] = await harness.db.execute<{
        failure_reason: string;
        metadata: Record<string, unknown>;
      }>(sql`SELECT failure_reason, metadata FROM agent_sessions WHERE id = ${sessionId}`);
      expect(row?.failure_reason).toBe('project_full');
      expect(row?.metadata).toMatchObject({ cap: 2, running: 2, issueId });
    });

    it('is a no-op when the job has no linked session', async () => {
      const { project } = await seedProject();
      const jobId = await insertJob(project.id, { agentSessionId: null });
      // Should not throw.
      await mods.markSessionGated(jobId, 'runner_full');
      // No assertion needed beyond "did not throw".
      expect(true).toBe(true);
    });
  });
});
