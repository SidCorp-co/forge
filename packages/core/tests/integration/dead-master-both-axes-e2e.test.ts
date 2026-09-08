/**
 * ISS-933 criteria 24, 25 and 27 — a dead master gives back BOTH kinds of work.
 *
 * The wave deletes `drive` from the pool, and the tempting next step is to
 * delete the pool's reaper with it. `devices/claim.ts` is still the only writer
 * of a non-null `jobs.held_by` and four kinds still claim through it, so that
 * deletion would remove a live safety net rather than dead code. This file is
 * the inverse assertion: the reaper survives, and the run axis recovers beside
 * it rather than instead of it.
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
  ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
  reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  reapDeadRunSessions: typeof import('../../src/devices/run-session-reaper.js').reapDeadRunSessions;
  openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  readAdmissibleIssues: typeof import('../../src/devices/admissible.js').readAdmissibleIssues;
  insertAndEnqueueJob: typeof import('../../src/pipeline/enqueue-helper.js').insertAndEnqueueJob;
  openOneShotRun: typeof import('../../src/pipeline/runs.js').openOneShotRun;
  RUN_SESSION_TIMEOUT_MS: typeof import('../../src/devices/run-session-reaper.js').RUN_SESSION_TIMEOUT_MS;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const ms = await import('../../src/devices/master-session.js');
  const mr = await import('../../src/devices/master-reaper.js');
  const rr = await import('../../src/devices/run-session-reaper.js');
  const rs = await import('../../src/devices/run-session.js');
  const ad = await import('../../src/devices/admissible.js');
  const eh = await import('../../src/pipeline/enqueue-helper.js');
  const runs = await import('../../src/pipeline/runs.js');
  mods = {
    ensureMasterSession: ms.ensureMasterSession,
    reapDeadMasterHolds: mr.reapDeadMasterHolds,
    reapDeadRunSessions: rr.reapDeadRunSessions,
    openRunSession: rs.openRunSession,
    readAdmissibleIssues: ad.readAdmissibleIssues,
    insertAndEnqueueJob: eh.insertAndEnqueueJob,
    openOneShotRun: runs.openOneShotRun,
    RUN_SESSION_TIMEOUT_MS: rr.RUN_SESSION_TIMEOUT_MS,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function aBoxServingAProject() {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const device = await createTestDevice(harness.db, user.id);
  await harness.db.execute(sql`
    INSERT INTO runners (device_id, project_id, name, type, status)
    VALUES (${device.id}, ${project.id}, 'r1', 'claude-code', 'online')
  `);
  return { user, project, device };
}

async function anIssue(projectId: string, userId: string, seq: number) {
  const rows = (await harness.db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id)
    VALUES (${projectId}, ${seq}, ${`work ${seq}`}, 'open', ${userId}) RETURNING id
  `)) as unknown as Array<Record<string, unknown>>;
  return { id: String(rows[0]?.id), key: `ISS-${seq}` };
}

async function aSmokeJobHeldBy(projectId: string, userId: string, sessionId: string) {
  const run = await mods.openOneShotRun({
    projectId,
    kind: 'system',
    metadata: { source: 'skills.smoke-verify', smoke: true },
  });
  const { jobId } = await mods.insertAndEnqueueJob({
    projectId,
    issueId: null,
    pipelineRunId: run.id,
    createdBy: userId,
    type: 'smoke',
    skillName: 'forge-code',
    promptString: 'canary',
    payloadExtras: { smoke: true },
  });
  await harness.db.execute(sql`
    UPDATE jobs SET held_by = ${sessionId}, held_at = now() - interval '10 minutes'
    WHERE id = ${jobId}
  `);
  return jobId;
}

async function heldByOf(jobId: string): Promise<string | null> {
  const [row] = (await harness.db.execute(sql`
    SELECT held_by FROM jobs WHERE id = ${jobId}
  `)) as unknown as Array<Record<string, unknown>>;
  return row?.held_by == null ? null : String(row.held_by);
}

describe('a master that dies holding work on both axes', () => {
  it('gives back its held smoke job and its two-issue run, and neither reaper does the other job', async () => {
    const { user, project, device } = await aBoxServingAProject();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-x',
    });
    const a = await anIssue(project.id, user.id, 957);
    const b = await anIssue(project.id, user.id, 958);
    const jobId = await aSmokeJobHeldBy(project.id, user.id, master.sessionId);
    const run = await mods.openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: [a.key, b.key],
      name: 'grp-957-958',
    });

    expect(
      await mods.readAdmissibleIssues({ deviceId: device.id }),
      'while the run is live, neither of its issues may be offered again — a per-box ledger cannot see another box, so this exclusion is the only thing stopping two runs over one issue (ISS-933 criterion 7)',
    ).toEqual([]);

    const dead = new Date(Date.now() - 10 * 60_000).toISOString();
    await harness.db.execute(sql`
      UPDATE agent_sessions SET status = 'failed', last_heartbeat_at = ${dead}, updated_at = ${dead}
      WHERE id = ${master.sessionId}
    `);
    const stale = new Date(Date.now() - mods.RUN_SESSION_TIMEOUT_MS - 60_000).toISOString();
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = ${stale}, updated_at = ${stale}
      WHERE id = ${run.sessionId}
    `);

    const released = await mods.reapDeadMasterHolds();
    expect(
      released,
      '`devices/claim.ts` is still the only writer of a non-null `jobs.held_by` and four kinds claim through it, so deleting this reaper with `drive` would remove a live safety net rather than dead code (ISS-933 criterion 24)',
    ).toBe(1);
    expect(await heldByOf(jobId)).toBeNull();

    const reaped = await mods.reapDeadRunSessions();
    expect(reaped.map((r) => r.issueKeys)).toEqual([[a.key, b.key]]);

    expect(
      (await mods.readAdmissibleIssues({ deviceId: device.id })).map((i) => i.issueId).sort(),
      'both issues come back, and they come back through the RUN axis — the job reaper never touched them and could not have (ISS-933 criterion 25)',
    ).toEqual([a.id, b.id].sort());
  });

  it('leaves the smoke job alone when only the run axis fires', async () => {
    const { user, project, device } = await aBoxServingAProject();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-y',
    });
    const jobId = await aSmokeJobHeldBy(project.id, user.id, master.sessionId);

    await mods.reapDeadRunSessions();

    expect(
      await heldByOf(jobId),
      'the run reaper writes `agent_sessions` and the run, never `jobs.held_by`. One reaper doing both jobs is how a hold comes back off a master that is still working — the epodsystem wedge of 2026-09-05',
    ).toBe(master.sessionId);
  });
});

describe('a job minted while no master is alive', () => {
  it('publishes a wake, because no issue arrival will', async () => {
    const { user, project, device } = await aBoxServingAProject();
    const { roomManager } = await import('../../src/ws/server.js');
    const { deviceRoom } = await import('../../src/ws/rooms.js');
    const seen: unknown[] = [];
    const spy = vi.spyOn(roomManager, 'publish').mockImplementation((room, frame) => {
      if (room === deviceRoom(device.id)) seen.push(frame);
      return 1;
    });

    await aSmokeJobHeldBy(project.id, user.id, '00000000-0000-4000-8000-000000000000').catch(
      () => undefined,
    );

    spy.mockRestore();
    expect(
      seen.map((f) => (f as { event: string }).event),
      'a `smoke` mint has no issue behind it, so nothing else would wake the box — and the four kinds that survived the pool are exactly the ones with no issue for `forge next` to rank (ISS-933 criterion 27)',
    ).toContain('master.wake');
  });
});
