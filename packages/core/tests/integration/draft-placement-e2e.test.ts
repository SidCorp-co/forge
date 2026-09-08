/**
 * ISS-940 — a draft somebody is already working, against real Postgres.
 *
 * The filer's acceptance test is mechanical and it is about two writes at
 * once: the transition must be ACCEPTED, and it must mint nothing. `open` is
 * the rung that was legal, and promoting is exactly what dispatches — ISS-933
 * sat at `draft` under a green-gated PR because saying "someone is on this"
 * meant racing a runner-dispatched agent into the worktree the session was
 * already in. Neither half is visible without a real transition against a
 * real schema, so both are watched here.
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

describe('ISS-940 draft placement (real Postgres)', () => {
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
    await harness.db.execute(sql`
      UPDATE projects SET agent_config = ${JSON.stringify({ pipelineConfig: { enabled: true } })}::jsonb
      WHERE id = ${projectId}
    `);
  });

  async function insertDraft(seq: number): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`draft ${seq}`}, 'draft', ${ownerId})
    `);
    return id;
  }

  async function load(id: string) {
    const rows = await harness.db.execute(sql`
      SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
      FROM issues WHERE id = ${id}
    `);
    return rows[0] as never;
  }

  async function countsFor(issueId: string): Promise<{ jobs: number; runs: number }> {
    const [jobs] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE issue_id = ${issueId}`,
    );
    const [runs] = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE issue_id = ${issueId}`,
    );
    return { jobs: jobs?.n ?? 0, runs: runs?.n ?? 0 };
  }

  /** Dispatch is asynchronous — the transition writes an outbox row and the
   *  reconciler is the pass that acts on it, so eligibility is what is asked
   *  here, not what one function call did. */
  async function age(id: string): Promise<void> {
    await harness.db.execute(
      sql`UPDATE issues SET updated_at = now() - interval '2 hours' WHERE id = ${id}`,
    );
  }

  it('takes a draft up in place, and nothing dispatches onto it', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    const id = await insertDraft(1);

    await applyStatusTransition(await load(id), 'in_progress', { id: ownerId, ownerId });
    await age(id);
    await runReconcilerOnce();

    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${id}`,
    );
    expect(row?.status).toBe('in_progress');
    expect(await countsFor(id)).toEqual({ jobs: 0, runs: 0 });
  });

  // cm:guard this is the alternative the rung exists to replace, and it must keep dispatching — a `draft → open` that minted nothing would mean the promotion path had broken, not that the new rung was safe
  // cm:guard the same draft moved to `open` must produce NO run and NO job since ISS-933 — it is offered to a master instead. The reconciler ran here on purpose: a pass that re-dispatched what dispatch itself stopped minting would be the second live path arriving through the backstop.
  it('mints nothing when the same draft is moved to the entry status', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const { runReconcilerOnce } = await import('../../src/pipeline/reconciler.js');
    const id = await insertDraft(2);

    await applyStatusTransition(await load(id), 'open', { id: ownerId, ownerId });
    await age(id);
    await runReconcilerOnce();

    const counts = await countsFor(id);
    expect(counts.jobs).toBe(0);
    expect(counts.runs).toBe(0);
  });

  // cm:guard the wedge pass is the one thing that could undo this rung: it rolls an in-flight status back to `open` and re-dispatches. It requires a prior `drive` job row and a running issue run, and a draft worked by hand has neither — if that ever stops being true, a live hand session gets an agent dropped into its worktree.
  it('is not rolled back by the autonomous wedge pass', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const { resetAutonomousWedgesOnce } = await import('../../src/pipeline/reconciler.js');
    const id = await insertDraft(3);

    await applyStatusTransition(await load(id), 'in_progress', { id: ownerId, ownerId });
    await age(id);

    expect(await resetAutonomousWedgesOnce()).toBe(0);
    const [row] = await harness.db.execute<{ status: string }>(
      sql`SELECT status FROM issues WHERE id = ${id}`,
    );
    expect(row?.status).toBe('in_progress');
  });

  it('still refuses a draft reaching for a mid-pipeline rung', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const id = await insertDraft(4);

    await expect(
      applyStatusTransition(await load(id), 'testing', { id: ownerId, ownerId }),
    ).rejects.toThrow(/draft/);
  });
});
