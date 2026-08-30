/**
 * ISS-879 — `alarmPausedRunsWithQueuedWork` against real Postgres.
 *
 * The gate reason `pipeline_run_not_running` was the only one that could hold a
 * `queued` job with no reaper and no alarm behind it. Measured on the live fleet
 * 2026-08-30: four triage jobs on `qa-project-available-for-testing` had been
 * queued for 38 days under runs paused at `missing_skill:open`, invisible to
 * every surface — `alarmStalledQueuedJobs` filters `pr.status = 'running'`, and
 * dropping that filter would not have helped, because their gate reason is not
 * the absence this pass tests for. Because `jobs_active_unique` covers `queued`,
 * those four issues could never receive a replacement step either.
 *
 * The unit suite pins the emit shape against a mocked db. This file exists for
 * the QUERY and for the negative: a mocked `db.execute` cannot be wrong about
 * which runs the WHERE clause admits, and "does not alarm a healthy queue" is
 * the assertion the whole design rests on.
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
const resolveWedgeMock = vi.fn(async (_entityId: string) => 0);
vi.mock('../../src/pipeline/wedge.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...args),
    resolvePipelineWedge: (id: string) => resolveWedgeMock(id),
  };
});

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  alarmPausedRunsWithQueuedWork: typeof import('../../src/pipeline/inv7-alarms.js').alarmPausedRunsWithQueuedWork;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  PAUSED_RUN_ALARM_MS: typeof import('../../src/pipeline/inv7-alarms.js').PAUSED_RUN_ALARM_MS;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  cancelPipelineRun: typeof import('../../src/pipeline/runs-control.js').cancelPipelineRun;
};

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

  mods = {
    ...((await import('../../src/pipeline/inv7-alarms.js')) as unknown as Mods),
    ...((await import('../../src/pipeline/runs-control.js')) as unknown as Mods),
  };
  const { registerPausedRunWedgeResolve } = await import(
    '../../src/pipeline/paused-run-wedge-resolve.js'
  );
  const { hooks } = await import('../../src/pipeline/hooks.js');
  registerPausedRunWedgeResolve(hooks);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  emitWedgeMock.mockClear();
  resolveWedgeMock.mockClear();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  const project = await createTestProject(harness.db, owner.id);
  projectId = project.id;
});

let seq = 500;
async function insertIssue(status = 'open'): Promise<{ id: string; seq: number }> {
  const id = randomUUID();
  const s = seq++;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${id}, ${projectId}, ${s}, 'a queued step', ${status}, 'medium', ${ownerId})
  `);
  return { id, seq: s };
}

async function insertRun(args: {
  issueId: string;
  status: 'running' | 'paused';
  pauseReason?: string | null;
  ageHours: number;
}): Promise<string> {
  const runId = randomUUID();
  const metadata = args.pauseReason
    ? JSON.stringify({ pauseReason: args.pauseReason })
    : JSON.stringify({});
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step, metadata, started_at, updated_at)
    VALUES (${runId}, ${projectId}, ${args.issueId}, 'issue', ${args.status}, 'triage', ${metadata}::jsonb,
            now() - (${args.ageHours} || ' hours')::interval,
            now() - (${args.ageHours} || ' hours')::interval)
  `);
  return runId;
}

async function insertQueuedJob(issueId: string, runId: string, type = 'triage'): Promise<string> {
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, queued_at)
    VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, ${ownerId}, ${type}, 'queued', '{}'::jsonb, now())
  `);
  return jobId;
}

function wedgeAt(i = 0): Record<string, string> {
  return emitWedgeMock.mock.calls[i]?.[0] as unknown as Record<string, string>;
}

describe('alarmPausedRunsWithQueuedWork E2E (ISS-879) — what it reports', () => {
  it('alarms a queued job frozen under a paused run, naming the pause reason', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: 'missing_skill:open',
      ageHours: 24,
    });
    await insertQueuedJob(issue.id, runId);

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(1);
    const w = wedgeAt();
    expect(w.entity).toBe('run');
    expect(w.entityId).toBe(`paused:${runId}`);
    expect(w.reason).toContain('missing_skill:open');
    expect(w.summary).toContain(`ISS-${issue.seq}`);
    expect(w.summary).toContain('triage');
    // cm:guard the copy must name WHEN the pause started — 38 days and 38 minutes need the same wedge to read differently, and the row carries no duration, only this timestamp
    expect(w.summary).toMatch(/paused since \d{4}-\d{2}-\d{2} /);
  });

  // cm:guard the specimen that must stay SILENT — the 2026-08-11 comment on ISS-765 (human-authored) rejected an age-based reaper precisely because a job legitimately queued behind the project cap is byte-identical to an orphan. This pass never looks at a `running` run, and this assertion is what proves it rather than asserting it in prose.
  it('stays silent on a healthy job queued under a running run, however old', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({ issueId: issue.id, status: 'running', ageHours: 900 });
    await insertQueuedJob(issue.id, runId);

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('stays silent on a paused run with nothing queued behind it', async () => {
    const issue = await insertIssue();
    await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: 'stage_stalled:released',
      ageHours: 500,
    });

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(0);
  });

  it('stays silent while the pause is younger than the threshold', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: 'missing_skill:open',
      ageHours: Math.floor(mods.PAUSED_RUN_ALARM_MS / 3_600_000) - 1,
    });
    await insertQueuedJob(issue.id, runId);

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(0);
  });
});

describe('alarmPausedRunsWithQueuedWork E2E (ISS-879) — when it stays quiet and when it clears', () => {
  it('emits ONE wedge per run, not one per frozen job', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: 'missing_skill:open',
      ageHours: 48,
    });
    await insertQueuedJob(issue.id, runId, 'triage');
    await insertQueuedJob(issue.id, runId, 'plan');
    await insertQueuedJob(issue.id, runId, 'code');

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    expect(wedgeAt().summary).toContain('3 steps');
  });

  // cm:guard the copy must come from `pauseResumesItself`, never from the pass's own opinion — `stage_stalled` has no resume path anywhere in the repo, and telling an operator it clears by itself is how a run sat 23 days with everyone believing it was handled (the same failure `alarmAgedHolds` carries a guard against)
  it('tells the operator the truth about whether the pause clears by itself', async () => {
    const machine = await insertIssue();
    const machineRun = await insertRun({
      issueId: machine.id,
      status: 'paused',
      pauseReason: 'missing_skill:open',
      ageHours: 48,
    });
    await insertQueuedJob(machine.id, machineRun);

    await mods.alarmPausedRunsWithQueuedWork(new Date());
    expect(wedgeAt().nextStep).toContain('resumes on its own');
    emitWedgeMock.mockClear();
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;

    const human = await insertIssue();
    const humanRun = await insertRun({
      issueId: human.id,
      status: 'paused',
      pauseReason: 'stage_stalled:released',
      ageHours: 48,
    });
    await insertQueuedJob(human.id, humanRun);

    await mods.alarmPausedRunsWithQueuedWork(new Date());
    expect(wedgeAt().nextStep).toContain('will NOT resume');
  });

  // cm:guard the operator cancel path must reach `pipelineRunStatusChanged` — `cancelPipelineRun` only WS-broadcast for its whole life, so the wedge's ONLY clearer never fired and the notification the alarm had just written stayed unresolved forever. That is the 721-row bell the wedge module's own guard is about, and the wedge copy tells the operator to cancel, so this is the path it steers them onto.
  it('clears the notification when the operator cancels the paused run', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: 'stage_stalled:testing',
      ageHours: 48,
    });
    await insertQueuedJob(issue.id, runId);

    await mods.alarmPausedRunsWithQueuedWork(new Date());
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    resolveWedgeMock.mockClear();

    await mods.cancelPipelineRun(runId, { parkIssue: false });

    expect(resolveWedgeMock).toHaveBeenCalledWith(`paused:${runId}`);
  });

  it('names an operator pause as a human decision, not a machine fault', async () => {
    const issue = await insertIssue();
    const runId = await insertRun({
      issueId: issue.id,
      status: 'paused',
      pauseReason: null,
      ageHours: 48,
    });
    await insertQueuedJob(issue.id, runId);

    const res = await mods.alarmPausedRunsWithQueuedWork(new Date());

    expect(res.alerted).toBe(1);
    expect(wedgeAt().reason).toContain('operator');
  });
});
