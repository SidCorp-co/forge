/**
 * `alarmUnrunnableBlockedDependents` against real Postgres.
 *
 * The gate is correct: an edge onto a `draft` issue means the draft really must
 * come first (owner decision 2026-08-14). What was broken is that the wait was
 * silent — measured the same day, brand-gateway ISS-50 sat queued 15 days behind
 * three `draft` blockers and anhome ISS-313 22 days behind two, with no
 * notification of any kind and no `waitingOn` a UI could show.
 *
 * The unit suite pins the emit shape against a mocked db. This one exists for
 * the QUERY: five joins, a window function and a grace cutoff, none of which a
 * mocked `db.execute` can be wrong about.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../src/pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...args),
  resolvePipelineWedge: async () => 0,
}));

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  alarmUnrunnableBlockedDependents: typeof import('../../src/pipeline/blocked-dependent-alarms.js').alarmUnrunnableBlockedDependents;
};

describe('alarmUnrunnableBlockedDependents E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;
  let ownerId: string;

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

    mods = (await import('../../src/pipeline/blocked-dependent-alarms.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    emitWedgeMock.mockClear();
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
  });

  let seq = 100;
  async function insertIssue(
    status: string,
    title = 'issue',
  ): Promise<{ id: string; seq: number }> {
    const id = randomUUID();
    const s = seq++;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (${id}, ${projectId}, ${s}, ${title}, ${status}, 'medium', ${ownerId})
    `);
    return { id, seq: s };
  }

  /** A queued job under a running run, aged past the grace window by default. */
  async function insertQueuedJob(issueId: string, ageMinutes = 90): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
    `);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, queued_at)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, 'code', 'queued', '{}'::jsonb,
              now() - (${ageMinutes} || ' minutes')::interval)
    `);
    return jobId;
  }

  async function blocks(blockerId: string, dependentId: string): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${randomUUID()}, ${projectId}, ${blockerId}, ${dependentId}, 'blocks')
    `);
  }

  // cm:guard the real query is five joins deep with a window function — a mocked `db.execute` cannot be wrong about any of it, which is why this file exists alongside the unit suite
  it('alarms a job blocked by a draft issue, naming it', async () => {
    const blocker = await insertIssue('draft', 'a11y: sign-up link fails axe');
    const dependent = await insertIssue('approved');
    await blocks(blocker.id, dependent.id);
    await insertQueuedJob(dependent.id);

    const res = await mods.alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.issueId).toBe(dependent.id);
    expect(wedge.summary).toContain(`ISS-${blocker.seq}`);
    expect(wedge.summary).toContain('a11y: sign-up link fails axe');
  });

  // cm:guard the getcontent 2026-08-22 shape: a consolidation dropped ISS-463 and its stale `blocks` edge held ISS-455, and through ISS-455 held ISS-457, queued 53h against four idle unlimited runners with NOTHING told to anyone. A dropped blocker never stamps `merged_at`, so unlike a draft it cannot even be opened — the guidance has to differ or the operator hunts for something to open.
  it('alarms a job blocked by a dropped issue and says to expire the edge', async () => {
    const blocker = await insertIssue('dropped', 'settings write-surface gaps G1-G3');
    const dependent = await insertIssue('approved');
    await blocks(blocker.id, dependent.id);
    await insertQueuedJob(dependent.id);

    const res = await mods.alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.issueId).toBe(dependent.id);
    expect(wedge.reason).toBe('blocker_dropped:1');
    expect(wedge.summary).toContain('will never merge');
    expect(wedge.nextStep).toContain('validUntil');
  });

  // cm:guard this is the brand-gateway ISS-50 shape exactly (3 draft blockers, measured 2026-08-14) — one wedge, not three, or the operator reads one stuck issue as three problems
  it('collapses several draft blockers on one issue into a single wedge', async () => {
    const dependent = await insertIssue('approved');
    for (let i = 0; i < 3; i++) {
      const b = await insertIssue('draft', `draft blocker ${i}`);
      await blocks(b.id, dependent.id);
    }
    await insertQueuedJob(dependent.id);

    const res = await mods.alarmUnrunnableBlockedDependents(new Date());

    expect(res.alerted).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    const wedge = emitWedgeMock.mock.calls[0]?.[0] as Record<string, string>;
    expect(wedge.summary).toContain('2 other blockers');
  });

  // cm:guard the grace window is what keeps this off a normal queue — without it every job enqueued behind a draft alarms instantly, and an alarm that fires on healthy state is one operators learn to ignore
  it('stays quiet inside the grace window', async () => {
    const blocker = await insertIssue('draft');
    const dependent = await insertIssue('approved');
    await blocks(blocker.id, dependent.id);
    await insertQueuedJob(dependent.id, 1);

    expect((await mods.alarmUnrunnableBlockedDependents(new Date())).alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('ignores a blocker that is open, and an expired edge', async () => {
    const openBlocker = await insertIssue('open');
    const d1 = await insertIssue('approved');
    await blocks(openBlocker.id, d1.id);
    await insertQueuedJob(d1.id);

    const draftBlocker = await insertIssue('draft');
    const d2 = await insertIssue('approved');
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind, valid_until)
      VALUES (${randomUUID()}, ${projectId}, ${draftBlocker.id}, ${d2.id}, 'blocks', now() - interval '1 day')
    `);
    await insertQueuedJob(d2.id);

    expect((await mods.alarmUnrunnableBlockedDependents(new Date())).alerted).toBe(0);
  });

  // cm:guard a job under a paused or terminal run is not waiting on the draft — `run_not_running` is its real reason, and reporting the draft instead sends the operator to fix the wrong thing
  it('ignores a job whose run is not running', async () => {
    const blocker = await insertIssue('draft');
    const dependent = await insertIssue('approved');
    await blocks(blocker.id, dependent.id);
    await insertQueuedJob(dependent.id);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'paused'`);

    expect((await mods.alarmUnrunnableBlockedDependents(new Date())).alerted).toBe(0);
  });

  it('scopes to one project when asked', async () => {
    const blocker = await insertIssue('draft');
    const dependent = await insertIssue('approved');
    await blocks(blocker.id, dependent.id);
    await insertQueuedJob(dependent.id);

    expect((await mods.alarmUnrunnableBlockedDependents(new Date(), { projectId })).alerted).toBe(
      1,
    );
    emitWedgeMock.mockClear();
    const other = await createTestProject(harness.db, ownerId);
    expect(
      (await mods.alarmUnrunnableBlockedDependents(new Date(), { projectId: other.id })).alerted,
    ).toBe(0);
  });
});
