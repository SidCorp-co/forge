/**
 * ISS-933 criteria 4 and 23 — measured, not reasoned.
 *
 * The whole wave rests on core minting no `drive` work, and the way that claim
 * fails quietly is by taking the other four kinds with it. So both halves run
 * in ONE file against a real Postgres: an issue reaching the entry status must
 * leave the `jobs` table untouched, and a `smoke` mint in the same database
 * must still produce exactly one row.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/queue/boss.js', () => ({
  boss: { send: vi.fn(async () => 'q1'), createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
  enqueueJob: vi.fn(async () => undefined),
  isBossStarted: () => true,
  startBoss: vi.fn(async () => undefined),
  stopBoss: vi.fn(async () => undefined),
}));

let harness: TestDatabase;
let mods: {
  dispatchAutonomous: typeof import('../../src/pipeline/autonomous-dispatch.js').dispatchAutonomous;
  dispatchDriveManual: typeof import('../../src/pipeline/autonomous-dispatch.js').dispatchDriveManual;
  insertAndEnqueueJob: typeof import('../../src/pipeline/enqueue-helper.js').insertAndEnqueueJob;
  openOneShotRun: typeof import('../../src/pipeline/runs.js').openOneShotRun;
  readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const dispatch = await import('../../src/pipeline/autonomous-dispatch.js');
  const helper = await import('../../src/pipeline/enqueue-helper.js');
  const runs = await import('../../src/pipeline/runs.js');
  const admissible = await import('../../src/devices/admissible.js');
  mods = {
    dispatchAutonomous: dispatch.dispatchAutonomous,
    dispatchDriveManual: dispatch.dispatchDriveManual,
    insertAndEnqueueJob: helper.insertAndEnqueueJob,
    openOneShotRun: runs.openOneShotRun,
    readAdmissibleIssues: admissible.readAdmissibleIssues,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function anOpenIssue(projectId: string, userId: string): Promise<{ id: string }> {
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
    VALUES (${projectId}, 933, 'work', 'open', ${userId}) RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;
  return { id: String(rows[0]?.id) };
}

async function countJobs(): Promise<number> {
  const [row] = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM jobs`,
  )) as unknown as Array<Record<string, unknown>>;
  return Number(row?.n ?? 0);
}

async function countRuns(): Promise<number> {
  const [row] = (await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM pipeline_runs`,
  )) as unknown as Array<Record<string, unknown>>;
  return Number(row?.n ?? 0);
}

describe('an issue reaching the autonomous entry status', () => {
  it('leaves the jobs table and the runs table exactly as they were', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issue = await anOpenIssue(project.id, user.id);

    const owned = await mods.dispatchAutonomous({
      projectId: project.id,
      issueId: issue.id,
      status: 'open',
      actor: { type: 'user', id: user.id, agency: 'human' },
      cfg: { enabled: true } as never,
      projectCreatedBy: user.id,
    });

    expect(owned, 'the autonomous driver still OWNS the decision — it just makes none').toBe(true);
    expect(
      await countJobs(),
      'core mints no `drive` job since ISS-933: a job here and a run session on the box would both claim one issue, and the box ledger can see only one of them (criteria 4 and 23)',
    ).toBe(0);
    expect(await countRuns()).toBe(0);
  });

  it('is offered to a master instead, which is the half that would fail silently', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const issue = await anOpenIssue(project.id, user.id);
    const device = await createTestDevice(harness.db, user.id);
    await harness.db.execute(sql`
      INSERT INTO runners (device_id, project_id, name, type, status)
      VALUES (${device.id}, ${project.id}, 'r1', 'claude-code', 'online')
    `);
    const deviceId = device.id;

    const offered = await mods.readAdmissibleIssues({ deviceId });

    expect(
      offered.map((o) => o.issueId),
      'with no job minted and the entry status not admissible, an autonomous project offers nothing at all and goes silent with no error anywhere saying why — that is the half criterion 23 does not mention and the one that breaks quietly (ISS-933 criterion 23)',
    ).toEqual([issue.id]);
  });
});

describe('the four kinds that stayed', () => {
  it('still mint exactly one job — the same sweep, so a change that silenced both fails here', async () => {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);

    const run = await mods.openOneShotRun({
      projectId: project.id,
      kind: 'system',
      metadata: { source: 'skills.smoke-verify', smoke: true },
    });
    await mods.insertAndEnqueueJob({
      projectId: project.id,
      issueId: null,
      pipelineRunId: run.id,
      createdBy: user.id,
      type: 'smoke',
      skillName: 'forge-code',
      promptString: 'canary',
      payloadExtras: { smoke: true },
    });

    const [row] = (await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'smoke'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(
      Number(row?.n ?? 0),
      'the pool keeps every verb for the four kinds that have no issue to rank — deleting `drive` from it must not take `smoke` with it (ISS-933 criterion 22)',
    ).toBe(1);
  });
});
