/**
 * ISS-119 — Decomposition lifecycle E2E.
 *
 * Validates the bits the unit suite cannot: the SQL in
 * `findDecompositionChildren` / `findDecompositionParent` against the real
 * `issue_dependencies` schema, the L2 release-gate's interaction with real
 * issue rows, and the picker SQL's decomposition-parent-not-released
 * filter. Skill registration is intentionally absent — the watcher's call
 * into `triggerPipelineStepManual` throws `NO_SKILL_REGISTERED` and the
 * subscriber catches and logs, which is the expected production fall-back
 * when an epic has no integration-test skill registered. The comment is
 * the observable evidence the handler fired.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// biome-ignore format: esbuild's TS transform cannot parse a line break inside import(); keep each typeof import(...) on one line
type Mods = {
  findDecompositionChildren: typeof import('../../src/pipeline/decomposition.js').findDecompositionChildren;
  findDecompositionParent: typeof import('../../src/pipeline/decomposition.js').findDecompositionParent;
  pickNextDispatchableJobForProject: typeof import('../../src/jobs/dispatch-gates.js').pickNextDispatchableJobForProject;
  registerDecompositionSubscribers: typeof import('../../src/pipeline/decomposition-subscribers.js').registerDecompositionSubscribers;
  applyStatusTransition: typeof import('../../src/issues/apply-transition.js').applyStatusTransition;
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
  drainOutboxOnce: typeof import('../../src/pipeline/outbox-worker.js').drainOutboxOnce;
};

describe('ISS-119 decomposition lifecycle E2E', () => {
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

    const [decompMod, gatesMod, subsMod, applyMod, hooksMod, outboxMod] = await Promise.all([
      import('../../src/pipeline/decomposition.js'),
      import('../../src/jobs/dispatch-gates.js'),
      import('../../src/pipeline/decomposition-subscribers.js'),
      import('../../src/issues/apply-transition.js'),
      import('../../src/pipeline/hooks.js'),
      import('../../src/pipeline/outbox-worker.js'),
    ]);
    mods = {
      findDecompositionChildren: decompMod.findDecompositionChildren,
      findDecompositionParent: decompMod.findDecompositionParent,
      pickNextDispatchableJobForProject: gatesMod.pickNextDispatchableJobForProject,
      registerDecompositionSubscribers: subsMod.registerDecompositionSubscribers,
      applyStatusTransition: applyMod.applyStatusTransition,
      hooks: hooksMod.hooks,
      drainOutboxOnce: outboxMod.drainOutboxOnce,
    };
    // Register subscribers ONCE for this suite — the bus is a module-level
    // singleton so duplicate registration would multiply handler firings.
    mods.registerDecompositionSubscribers(mods.hooks);
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---------- helpers ---------------------------------------------------

  async function insertIssue(
    projectId: string,
    ownerId: string,
    overrides: { status?: string; issSeq?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? 'open';
    const issSeq = overrides.issSeq ?? Math.floor(Math.random() * 100000);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, ${status},
        'medium', ${ownerId}
      )
    `);
    return id;
  }

  async function insertDecomposesEdge(
    projectId: string,
    parentId: string,
    childId: string,
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${id}, ${projectId}, ${parentId}, ${childId}, 'decomposes')
    `);
    return id;
  }

  async function insertReleaseJob(
    projectId: string,
    issueId: string,
    ownerId: string,
  ): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, queued_at, created_by)
      VALUES (
        ${id}, ${projectId}, ${issueId}, ${runId}, 'release', 'queued',
        '{}'::jsonb, now(), ${ownerId}
      )
    `);
    return id;
  }

  // ISS-131 — generic queued-job factory so sibling-chain tests can enqueue
  // a non-release job (e.g. `triage`) and assert the picker parks it.
  async function insertQueuedJob(
    projectId: string,
    issueId: string,
    ownerId: string,
    type: string,
  ): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running')
    `);
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, queued_at, created_by)
      VALUES (
        ${id}, ${projectId}, ${issueId}, ${runId}, ${type}, 'queued',
        '{}'::jsonb, now(), ${ownerId}
      )
    `);
    return id;
  }

  // The picker's `fresh_capable_runners` CTE now requires at least one online,
  // fresh runner before any job (release/triage) is dispatchable — otherwise
  // the EXISTS gate parks every job with `runner_stale`. Seed a fresh online
  // claude-code runner bound to a device so the picker tests assert their
  // decomposition-specific gating, not the runner-presence gate.
  async function seedFreshRunner(projectId: string, ownerId: string): Promise<string> {
    const deviceId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status)
      VALUES (
        ${deviceId}, ${ownerId}, ${`device-${deviceId.slice(0, 8)}`}, 'linux',
        ${`!test-device-hash-${deviceId}`}, ${deviceId.slice(0, 8)}, 'online'
      )
    `);
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', 'device', ${deviceId},
        ${`runner-${runnerId.slice(0, 8)}`}, '{}'::jsonb, 'online', now()
      )
    `);
    return runnerId;
  }

  async function insertBlocksEdge(
    projectId: string,
    fromIssueId: string,
    toIssueId: string,
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${id}, ${projectId}, ${fromIssueId}, ${toIssueId}, 'blocks')
    `);
    return id;
  }

  async function readIssueStatus(id: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM issues WHERE id = ${id}
    `);
    return rows[0]?.status ?? '';
  }

  async function readCommentCount(issueId: string): Promise<number> {
    const rows = await harness.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM comments WHERE issue_id = ${issueId}
    `);
    return Number(rows[0]?.count ?? '0');
  }

  // ---------- helpers: queries ------------------------------------------

  describe('findDecompositionChildren / findDecompositionParent', () => {
    it('returns children for a kind=decomposes edge and ignores other kinds', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { issSeq: 1 });
      const child = await insertIssue(project.id, owner.id, { issSeq: 2 });
      const other = await insertIssue(project.id, owner.id, { issSeq: 3 });
      await insertDecomposesEdge(project.id, parent, child);
      // Add a `blocks` edge between parent and `other` — must NOT appear.
      await harness.db.execute(sql`
        INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
        VALUES (${randomUUID()}, ${project.id}, ${parent}, ${other}, 'blocks')
      `);

      const children = await mods.findDecompositionChildren(parent);
      expect(children).toHaveLength(1);
      expect(children[0]?.id).toBe(child);
    });

    it('findDecompositionParent returns null when child has no inbound decomposes edge', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const loner = await insertIssue(project.id, owner.id);
      expect(await mods.findDecompositionParent(loner)).toBeNull();
    });

    it('findDecompositionParent finds the parent via inverse query', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { issSeq: 11 });
      const child = await insertIssue(project.id, owner.id, { issSeq: 12 });
      await insertDecomposesEdge(project.id, parent, child);

      const found = await mods.findDecompositionParent(child);
      expect(found?.id).toBe(parent);
      expect(found?.issSeq).toBe(11);
    });

    it('respects valid_until (expired edges are ignored)', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { issSeq: 21 });
      const child = await insertIssue(project.id, owner.id, { issSeq: 22 });
      await harness.db.execute(sql`
        INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
        VALUES (
          ${randomUUID()}, ${project.id}, ${parent}, ${child},
          'decomposes', now() - interval '1 day'
        )
      `);
      expect(await mods.findDecompositionChildren(parent)).toHaveLength(0);
      expect(await mods.findDecompositionParent(child)).toBeNull();
    });
  });

  // ---------- Picker SQL filter -----------------------------------------

  describe('pickNextDispatchableJobForProject', () => {
    it('excludes release jobs whose decomposition parent is not released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 61 });
      const child = await insertIssue(project.id, owner.id, { status: 'tested', issSeq: 62 });
      await insertDecomposesEdge(project.id, parent, child);
      await insertReleaseJob(project.id, child, owner.id);

      const pick = await mods.pickNextDispatchableJobForProject(project.id);
      expect(pick).toBeNull();
    });

    it('admits the release job once the parent reaches released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      await seedFreshRunner(project.id, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'released', issSeq: 71 });
      const child = await insertIssue(project.id, owner.id, { status: 'tested', issSeq: 72 });
      await insertDecomposesEdge(project.id, parent, child);
      await insertReleaseJob(project.id, child, owner.id);

      const pick = await mods.pickNextDispatchableJobForProject(project.id);
      expect(pick).not.toBeNull();
      // Raw `db.execute<JobRow>` keeps snake_case keys — the `<JobRow>` cast
      // is a TS-only hint, not a runtime mapping. Read the snake_case field.
      expect((pick as unknown as { issue_id: string } | null)?.issue_id).toBe(child);
    });

    // ISS-131 AC#5 — sibling-blocks ordering inside a decomposition must gate
    // downstream children at dispatch time. Reproduces the ISS-121 dogfood
    // failure: parent + 3 children all `approved` (post cascade), the
    // forge-plan skill declared sub1→sub2→sub3 `blocks` edges, and three
    // `triage` jobs are queued. Only sub1 should be pickable; sub2 and sub3
    // must stay queued until their blocker hits a terminal status.
    it('sibling blocks edges within a decomposition gate downstream triage dispatch', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      await seedFreshRunner(project.id, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 200 });
      const sub1 = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 201 });
      const sub2 = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 202 });
      const sub3 = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 203 });

      // Decomposition edges + sibling-blocks chain (sub1 → sub2 → sub3).
      await insertDecomposesEdge(project.id, parent, sub1);
      await insertDecomposesEdge(project.id, parent, sub2);
      await insertDecomposesEdge(project.id, parent, sub3);
      await insertBlocksEdge(project.id, sub1, sub2);
      await insertBlocksEdge(project.id, sub2, sub3);

      const j1 = await insertQueuedJob(project.id, sub1, owner.id, 'triage');
      await insertQueuedJob(project.id, sub2, owner.id, 'triage');
      await insertQueuedJob(project.id, sub3, owner.id, 'triage');

      // First sweep: only sub1's triage is pickable; sub2/sub3 are parked
      // because the picker's `NOT EXISTS (... blocks ...)` filter excludes
      // them at the SQL level.
      const first = await mods.pickNextDispatchableJobForProject(project.id);
      expect(first).not.toBeNull();
      expect((first as unknown as { id: string; issue_id: string })?.id).toBe(j1);
      expect((first as unknown as { id: string; issue_id: string })?.issue_id).toBe(sub1);

      // Simulate sub1 reaching terminal — sub2 unblocks, sub3 still waits.
      // ISS-232 — the `blockedBy` gate is satisfied when the blocker has
      // `merged_at` stamped (or, only under a structurally-unstampable base,
      // is `closed` — ISS-639). This project's base IS stampable (default
      // config), so `closed` alone no longer unblocks sub2 — stamp
      // `merged_at` too (mirrors the real `mark_merged` path).
      await harness.db.execute(sql`
        UPDATE jobs SET status = 'completed', finished_at = now() WHERE id = ${j1}
      `);
      await harness.db.execute(
        sql`UPDATE issues SET status = 'closed', merged_at = now() WHERE id = ${sub1}`,
      );

      const second = await mods.pickNextDispatchableJobForProject(project.id);
      expect(second).not.toBeNull();
      expect((second as unknown as { issue_id: string })?.issue_id).toBe(sub2);
      // sub3 is still gated by sub2 (which is still queued, not terminal).
      // The picker would normally pick sub2 first; force it past pick by
      // flipping it to dispatched so the next pick attempt evaluates sub3.
      // sub3 must remain unpickable because its blocker sub2 is not terminal.
      await harness.db.execute(sql`
        UPDATE jobs SET status = 'dispatched' WHERE id = ${(second as unknown as { id: string }).id}
      `);
      const third = await mods.pickNextDispatchableJobForProject(project.id);
      expect(third).toBeNull();
    });
  });

  // ---------- Hook subscribers ------------------------------------------

  describe('cascade approve', () => {
    it('flips open children to approved when parent transitions waiting → approved', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      // Children parked at `draft` — CASCADE_APPROVE_FROM_STATUSES is
      // {draft, on_hold} (decomposition-subscribers.ts). An `open` child is
      // never promoted by the cascade.
      const parent = await insertIssue(project.id, owner.id, { status: 'waiting', issSeq: 81 });
      const childA = await insertIssue(project.id, owner.id, { status: 'draft', issSeq: 82 });
      const childB = await insertIssue(project.id, owner.id, { status: 'draft', issSeq: 83 });
      const childC = await insertIssue(project.id, owner.id, { status: 'draft', issSeq: 84 });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);
      await insertDecomposesEdge(project.id, parent, childC);

      await mods.applyStatusTransition(
        { id: parent, projectId: project.id, status: 'waiting', reopenCount: 0 },
        'approved',
        { id: owner.id, ownerId: owner.id },
      );
      // ISS-196 — applyStatusTransition no longer emits `transition` inline; it
      // writes a pipeline_outbox row via trigger. Drain it so the decomposition
      // subscriber fires the cascade. (Children flip to approved → their own
      // outbox rows, but no subscriber acts on a `draft→approved` child here.)
      await mods.drainOutboxOnce();

      expect(await readIssueStatus(childA)).toBe('approved');
      expect(await readIssueStatus(childB)).toBe('approved');
      expect(await readIssueStatus(childC)).toBe('approved');
    });
  });

  describe('close cascade', () => {
    it('forces non-closed children to closed when parent → closed', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      // Parent starts at `released` — the canonical pre-close status — so the
      // state-machine permits `released → closed` without `{ skip: true }`.
      const parent = await insertIssue(project.id, owner.id, { status: 'released', issSeq: 91 });
      const childA = await insertIssue(project.id, owner.id, { status: 'tested', issSeq: 92 });
      const childB = await insertIssue(project.id, owner.id, { status: 'closed', issSeq: 93 });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);

      await mods.applyStatusTransition(
        { id: parent, projectId: project.id, status: 'released', reopenCount: 0 },
        'closed',
        { id: owner.id, ownerId: owner.id },
      );
      // ISS-196 — drain the outbox so the close-cascade subscriber fires.
      await mods.drainOutboxOnce();

      expect(await readIssueStatus(parent)).toBe('closed');
      expect(await readIssueStatus(childA)).toBe('closed');
      // Already-closed child stays closed (no NO_OP error since handler skips it).
      expect(await readIssueStatus(childB)).toBe('closed');
    });
  });

  describe('watcher', () => {
    it('posts a comment on the parent when the LAST child reaches tested', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 101 });
      const childA = await insertIssue(project.id, owner.id, { status: 'tested', issSeq: 102 });
      const childB = await insertIssue(project.id, owner.id, { status: 'developed', issSeq: 103 });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);

      // Transitioning childA early (only 1 of 2 tested) → watcher must NOT fire.
      // Note: childA is already at `tested`. We bring childB to `tested` next.
      expect(await readCommentCount(parent)).toBe(0);

      await mods.applyStatusTransition(
        { id: childB, projectId: project.id, status: 'developed', reopenCount: 0 },
        'tested',
        { id: owner.id, ownerId: owner.id },
        { skip: true },
      );
      // ISS-196 — drain the outbox so the watcher subscriber fires on the
      // child's tested transition.
      await mods.drainOutboxOnce();

      // Now BOTH children are at tested — watcher posts exactly one comment.
      // The triggerPipelineStepManual call inside the watcher fails with
      // NO_SKILL_REGISTERED (no skill rows seeded); the handler catches that
      // and the comment insertion still ran first. Idempotency guard ensures
      // it stays at one.
      expect(await readCommentCount(parent)).toBe(1);
    });
  });
});
