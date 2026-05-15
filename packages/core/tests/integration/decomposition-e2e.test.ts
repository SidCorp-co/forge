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

type Mods = {
  findDecompositionChildren: typeof import('../../src/pipeline/decomposition.js').findDecompositionChildren;
  findDecompositionParent: typeof import('../../src/pipeline/decomposition.js').findDecompositionParent;
  checkLayer2Dependencies: typeof import('../../src/jobs/dispatch-gates.js').checkLayer2Dependencies;
  pickNextDispatchableJobForProject: typeof import('../../src/jobs/dispatch-gates.js').pickNextDispatchableJobForProject;
  registerDecompositionSubscribers: typeof import('../../src/pipeline/decomposition-subscribers.js').registerDecompositionSubscribers;
  applyStatusTransition: typeof import('../../src/issues/apply-transition.js').applyStatusTransition;
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
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

    const [decompMod, gatesMod, subsMod, applyMod, hooksMod] = await Promise.all([
      import('../../src/pipeline/decomposition.js'),
      import('../../src/jobs/dispatch-gates.js'),
      import('../../src/pipeline/decomposition-subscribers.js'),
      import('../../src/issues/apply-transition.js'),
      import('../../src/pipeline/hooks.js'),
    ]);
    mods = {
      findDecompositionChildren: decompMod.findDecompositionChildren,
      findDecompositionParent: decompMod.findDecompositionParent,
      checkLayer2Dependencies: gatesMod.checkLayer2Dependencies,
      pickNextDispatchableJobForProject: gatesMod.pickNextDispatchableJobForProject,
      registerDecompositionSubscribers: subsMod.registerDecompositionSubscribers,
      applyStatusTransition: applyMod.applyStatusTransition,
      hooks: hooksMod.hooks,
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
    overrides: { status?: string; issSeq?: number; manualHold?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? 'open';
    const issSeq = overrides.issSeq ?? Math.floor(Math.random() * 100000);
    const manualHold = overrides.manualHold ?? false;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, manual_hold, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq}, ${'Issue ' + issSeq}, ${status},
        'medium', ${manualHold}, ${ownerId}
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

  async function insertReleaseJob(projectId: string, issueId: string, ownerId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, queued_at, created_by)
      VALUES (
        ${id}, ${projectId}, ${issueId}, 'release', 'queued',
        '{}'::jsonb, now(), ${ownerId}
      )
    `);
    return id;
  }

  async function readIssueStatus(id: string): Promise<string> {
    const rows = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM issues WHERE id = ${id}
    `);
    return rows[0]?.status ?? '';
  }

  async function readManualHold(id: string): Promise<boolean> {
    const rows = await harness.db.execute<{ manual_hold: boolean }>(sql`
      SELECT manual_hold FROM issues WHERE id = ${id}
    `);
    return rows[0]?.manual_hold ?? false;
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

  // ---------- L2 release gate -------------------------------------------

  describe('L2 release gate', () => {
    it('blocks a release job when decomposition parent is not released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 31 });
      const child = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 32 });
      await insertDecomposesEdge(project.id, parent, child);

      const r = await mods.checkLayer2Dependencies(child, 'release');
      expect(r.pass).toBe(false);
      if (!r.pass) {
        expect(r.reason).toBe('waiting_on_decomp_parent');
        expect(r.metadata?.parentIssSeq).toBe(31);
      }
    });

    it('passes a release job when decomposition parent is released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'released', issSeq: 41 });
      const child = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 42 });
      await insertDecomposesEdge(project.id, parent, child);

      const r = await mods.checkLayer2Dependencies(child, 'release');
      expect(r.pass).toBe(true);
    });

    it('passes non-release jobs even when decomposition parent is mid-pipeline', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 51 });
      const child = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 52 });
      await insertDecomposesEdge(project.id, parent, child);

      const r = await mods.checkLayer2Dependencies(child, 'code');
      expect(r.pass).toBe(true);
    });
  });

  // ---------- Picker SQL filter -----------------------------------------

  describe('pickNextDispatchableJobForProject', () => {
    it('excludes release jobs whose decomposition parent is not released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 61 });
      const child = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 62 });
      await insertDecomposesEdge(project.id, parent, child);
      await insertReleaseJob(project.id, child, owner.id);

      const pick = await mods.pickNextDispatchableJobForProject(project.id);
      expect(pick).toBeNull();
    });

    it('admits the release job once the parent reaches released', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'released', issSeq: 71 });
      const child = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 72 });
      await insertDecomposesEdge(project.id, parent, child);
      await insertReleaseJob(project.id, child, owner.id);

      const pick = await mods.pickNextDispatchableJobForProject(project.id);
      expect(pick).not.toBeNull();
      expect(pick?.issueId).toBe(child);
    });
  });

  // ---------- Hook subscribers ------------------------------------------

  describe('cascade approve', () => {
    it('flips open children to approved when parent transitions waiting → approved', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'waiting', issSeq: 81 });
      const childA = await insertIssue(project.id, owner.id, { status: 'open', issSeq: 82 });
      const childB = await insertIssue(project.id, owner.id, { status: 'open', issSeq: 83 });
      const childC = await insertIssue(project.id, owner.id, { status: 'open', issSeq: 84, manualHold: true });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);
      await insertDecomposesEdge(project.id, parent, childC);

      await mods.applyStatusTransition(
        { id: parent, projectId: project.id, status: 'waiting', reopenCount: 0 },
        'approved',
        { id: owner.id, ownerId: owner.id },
      );

      expect(await readIssueStatus(childA)).toBe('approved');
      expect(await readIssueStatus(childB)).toBe('approved');
      expect(await readIssueStatus(childC)).toBe('approved');
      expect(await readManualHold(childC)).toBe(false);
    });
  });

  describe('close cascade', () => {
    it('forces non-closed children to closed when parent → closed', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      // Parent starts at `released` — the canonical pre-close status — so the
      // state-machine permits `released → closed` without `{ skip: true }`.
      const parent = await insertIssue(project.id, owner.id, { status: 'released', issSeq: 91 });
      const childA = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 92 });
      const childB = await insertIssue(project.id, owner.id, { status: 'closed', issSeq: 93 });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);

      await mods.applyStatusTransition(
        { id: parent, projectId: project.id, status: 'released', reopenCount: 0 },
        'closed',
        { id: owner.id, ownerId: owner.id },
      );

      expect(await readIssueStatus(parent)).toBe('closed');
      expect(await readIssueStatus(childA)).toBe('closed');
      // Already-closed child stays closed (no NO_OP error since handler skips it).
      expect(await readIssueStatus(childB)).toBe('closed');
    });
  });

  describe('watcher', () => {
    it('posts a comment on the parent when the LAST child reaches staging', async () => {
      const owner = await createTestUser(harness.db);
      const project = await createTestProject(harness.db, owner.id);
      const parent = await insertIssue(project.id, owner.id, { status: 'approved', issSeq: 101 });
      const childA = await insertIssue(project.id, owner.id, { status: 'staging', issSeq: 102 });
      const childB = await insertIssue(project.id, owner.id, { status: 'developed', issSeq: 103 });
      await insertDecomposesEdge(project.id, parent, childA);
      await insertDecomposesEdge(project.id, parent, childB);

      // Transitioning childA early (only 1 of 2 staging) → watcher must NOT fire.
      // Note: childA is already at `staging`. We bring childB to `staging` next.
      expect(await readCommentCount(parent)).toBe(0);

      await mods.applyStatusTransition(
        { id: childB, projectId: project.id, status: 'developed', reopenCount: 0 },
        'staging',
        { id: owner.id, ownerId: owner.id },
        { skip: true },
      );

      // Now BOTH children are at staging — watcher posts exactly one comment.
      // The triggerPipelineStepManual call inside the watcher fails with
      // NO_SKILL_REGISTERED (no skill rows seeded); the handler catches that
      // and the comment insertion still ran first. Idempotency guard ensures
      // it stays at one.
      expect(await readCommentCount(parent)).toBe(1);
    });
  });
});
