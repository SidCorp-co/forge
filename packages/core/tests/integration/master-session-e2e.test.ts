/**
 * ISS-919 — the claim SPLIT and the master's own session row, against a real
 * Postgres.
 *
 * Split out of `master-pool-e2e.test.ts` when that file passed its size budget:
 * these assertions are about the two acts of a claim and about the row that
 * gives a master an identity, where the sibling file is about the pool query
 * and the race. Both need the same real database for the same reason — a hold
 * that two transactions contend for cannot fail in a runtime without them.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let mods: {
  readPool: typeof import('../../src/devices/pool.js').readPool;
  prepareJobForMaster: typeof import('../../src/devices/claim.js').prepareJobForMaster;
  startJobForMaster: typeof import('../../src/devices/claim.js').startJobForMaster;
  releaseJobFromMaster: typeof import('../../src/devices/claim.js').releaseJobFromMaster;
  releaseAllHeldBySession: typeof import('../../src/devices/claim.js').releaseAllHeldBySession;
  readDeviceLoad: typeof import('../../src/devices/load.js').readDeviceLoad;
  readProjectLoad: typeof import('../../src/devices/load.js').readProjectLoad;
  readFleetLoad: typeof import('../../src/devices/load.js').readFleetLoad;
  reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  releaseHoldsForSession: typeof import('../../src/devices/master-reaper.js').releaseHoldsForSession;
  ensureMasterSession: typeof import('../../src/devices/master-session.js').ensureMasterSession;
  closeMasterSession: typeof import('../../src/devices/master-session.js').closeMasterSession;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const pool = await import('../../src/devices/pool.js');
  const claim = await import('../../src/devices/claim.js');
  const load = await import('../../src/devices/load.js');
  const reaper = await import('../../src/devices/master-reaper.js');
  const masterSession = await import('../../src/devices/master-session.js');
  mods = {
    readPool: pool.readPool,
    prepareJobForMaster: claim.prepareJobForMaster,
    startJobForMaster: claim.startJobForMaster,
    releaseJobFromMaster: claim.releaseJobFromMaster,
    releaseAllHeldBySession: claim.releaseAllHeldBySession,
    readDeviceLoad: load.readDeviceLoad,
    readProjectLoad: load.readProjectLoad,
    readFleetLoad: load.readFleetLoad,
    reapDeadMasterHolds: reaper.reapDeadMasterHolds,
    releaseHoldsForSession: reaper.releaseHoldsForSession,
    ensureMasterSession: masterSession.ensureMasterSession,
    closeMasterSession: masterSession.closeMasterSession,
  };
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const runner = randomUUID();
  const blockerIssue = randomUUID();
  const issue = randomUUID();
  const run = randomUUID();
  const job = randomUUID();

  await harness.db.execute(sql`
    UPDATE devices SET agent_version = '0.11.0', last_seen_at = now() WHERE id = ${device.id}
  `);
  await harness.db.execute(sql`
    UPDATE projects SET repo_path = '/tmp/pool-test' WHERE id = ${project.id}
  `);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, device_id, type, name, status, last_seen_at)
    VALUES (${runner}, ${project.id}, ${device.id}, 'claude-code', 'pool-runner', 'online', now())
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
    VALUES (${blockerIssue}, ${project.id}, 9001, 'blocker', 'dropped', 'medium', ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, description, status, priority, category, created_by_id)
    VALUES (${issue}, ${project.id}, 9002, 'the work', 'body text', 'open', 'high', 'core',
            ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind, created_by_id)
    VALUES (${project.id}, ${blockerIssue}, ${issue}, 'blocks', ${owner.id})
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
    VALUES (${run}, ${project.id}, ${issue}, 'issue', 'running')
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at)
    VALUES (${job}, ${project.id}, ${issue}, ${run}, 'code', 'queued', ${owner.id},
            now() - interval '30 minutes')
  `);

  return { owner, project, device, run, job, issue };
}

describe('the claim split', () => {
  it('prepares a job without starting it: still queued, now held, no box stamped', async () => {
    const { device, job } = await seed();
    const session = randomUUID();

    const prepared = await mods.prepareJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: session,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.agentSessionId).toBeTruthy();

    const [row] = (await harness.db.execute(sql`
      SELECT status, held_by, device_id, runner_id, dispatched_at FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('queued');
    expect(row?.held_by).toBe(session);
    expect(row?.device_id).toBeNull();
    expect(row?.runner_id).toBeNull();
    expect(row?.dispatched_at).toBeNull();
  });

  it('gives a preparation that never started back to the pool', async () => {
    const { device, job } = await seed();
    const session = randomUUID();
    await mods.prepareJobForMaster({ jobId: job, deviceId: device.id, sessionId: session });

    expect(await mods.releaseJobFromMaster({ jobId: job, sessionId: session })).toBe(true);
    const offered = await mods.readPool({ deviceId: device.id, limit: 20 });
    expect(offered.find((i) => i.jobId === job)).toBeDefined();
  });

  it('lets the reaper collect a preparation whose master went away', async () => {
    const { device, job } = await seed();
    await mods.prepareJobForMaster({ jobId: job, deviceId: device.id, sessionId: randomUUID() });
    await harness.db.execute(sql`
      UPDATE jobs SET held_at = now() - interval '10 minutes' WHERE id = ${job}
    `);
    expect(await mods.reapDeadMasterHolds()).toBe(1);
    const offered = await mods.readPool({ deviceId: device.id, limit: 20 });
    expect(offered.find((i) => i.jobId === job)).toBeDefined();
  });

  it('refuses a start from a session that does not hold the job', async () => {
    const { device, job } = await seed();
    await mods.prepareJobForMaster({ jobId: job, deviceId: device.id, sessionId: randomUUID() });

    const started = await mods.startJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(started).toEqual({ ok: false, reason: 'hold_lost' });
  });

  it('refuses a start whose hold the reaper took back, and leaves the job claimable', async () => {
    const { device, job } = await seed();
    const session = randomUUID();
    await mods.prepareJobForMaster({ jobId: job, deviceId: device.id, sessionId: session });
    await harness.db.execute(sql`UPDATE jobs SET held_by = NULL, held_at = NULL WHERE id = ${job}`);

    expect(
      await mods.startJobForMaster({ jobId: job, deviceId: device.id, sessionId: session }),
    ).toEqual({ ok: false, reason: 'hold_lost' });
    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('queued');
    expect(row?.device_id).toBeNull();
  });
});

describe('the master session', () => {
  it('returns one row per (device, project) however many times it is asked', async () => {
    const { device, project } = await seed();
    const first = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    const again = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.sessionId).toBe(first.sessionId);
  });

  it('is not confused by a pipeline session on the same device and project', async () => {
    const { device, project, run } = await seed();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, status, metadata)
      VALUES (${randomUUID()}, ${project.id}, ${device.id}, ${run}, 'running', '{"type":"pipeline"}')
    `);
    const a = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    const b = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    expect(a.created).toBe(true);
    expect(b.sessionId).toBe(a.sessionId);
  });

  it('lets the reaper judge a hold by the master heartbeat rather than by age', async () => {
    const { device, project, job } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    await mods.prepareJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: master.sessionId,
    });

    await harness.db.execute(sql`
      UPDATE jobs SET held_at = now() - interval '10 minutes' WHERE id = ${job}
    `);
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() WHERE id = ${master.sessionId}
    `);
    expect(await mods.reapDeadMasterHolds()).toBe(0);

    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '10 minutes'
      WHERE id = ${master.sessionId}
    `);
    expect(await mods.reapDeadMasterHolds()).toBe(1);
  });

  it('bumps the heartbeat when the runner re-registers, so a working master keeps its holds', async () => {
    const { device, project, job } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    await mods.prepareJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: master.sessionId,
    });
    await harness.db.execute(sql`
      UPDATE jobs SET held_at = now() - interval '10 minutes' WHERE id = ${job}
    `);
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '10 minutes'
      WHERE id = ${master.sessionId}
    `);

    const again = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    expect(again.sessionId).toBe(master.sessionId);
    expect(await mods.reapDeadMasterHolds()).toBe(0);
  });

  it('refuses to close a master session belonging to another device', async () => {
    const { device, project } = await seed();
    const master = await mods.ensureMasterSession({
      deviceId: device.id,
      projectId: project.id,
      name: 'forge-master-p',
    });
    expect(
      await mods.closeMasterSession({
        deviceId: randomUUID(),
        sessionId: master.sessionId,
        reason: 'pane vanished',
      }),
    ).toBe(false);
    expect(
      await mods.closeMasterSession({
        deviceId: device.id,
        sessionId: master.sessionId,
        reason: 'pane vanished',
      }),
    ).toBe(true);
  });
});
