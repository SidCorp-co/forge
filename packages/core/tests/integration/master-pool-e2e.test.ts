/**
 * The pool/claim contract, against a real Postgres.
 *
 * Every assertion here is about SQL and row locking, so a mocked db proves
 * nothing: two masters racing for one job cannot fail in a runtime with no
 * transactions, and the raw-relation shape is a `json_agg` no mock builds.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('master pool', () => {
  let harness: TestDatabase;
  let mods: {
    readPool: typeof import('../../src/devices/pool.js').readPool;
    claimJobForMaster: typeof import('../../src/devices/claim.js').claimJobForMaster;
    releaseJobFromMaster: typeof import('../../src/devices/claim.js').releaseJobFromMaster;
    releaseAllHeldBySession: typeof import('../../src/devices/claim.js').releaseAllHeldBySession;
    readDeviceLoad: typeof import('../../src/devices/load.js').readDeviceLoad;
    readProjectLoad: typeof import('../../src/devices/load.js').readProjectLoad;
    reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  };

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    const pool = await import('../../src/devices/pool.js');
    const claim = await import('../../src/devices/claim.js');
    const load = await import('../../src/devices/load.js');
    const reaper = await import('../../src/devices/master-reaper.js');
    mods = {
      readPool: pool.readPool,
      claimJobForMaster: claim.claimJobForMaster,
      releaseJobFromMaster: claim.releaseJobFromMaster,
      releaseAllHeldBySession: claim.releaseAllHeldBySession,
      readDeviceLoad: load.readDeviceLoad,
      readProjectLoad: load.readProjectLoad,
      reapDeadMasterHolds: reaper.reapDeadMasterHolds,
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
      UPDATE devices SET agent_version = '0.10.5', last_seen_at = now() WHERE id = ${device.id}
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

    return { owner, project, device, run, job };
  }

  it('offers a job whose blocker never merged, and reports the blocker raw', async () => {
    const { device, job } = await seed();
    const items = await mods.readPool({ deviceId: device.id, limit: 20 });
    const entry = items.find((i) => i.jobId === job);

    expect(
      entry,
      'a blocked job must still be OFFERED — the master decides, not a gate',
    ).toBeDefined();
    expect(entry?.issueKey).toBe('ISS-9002');
    expect(entry?.description).toBe('body text');
    expect(entry?.ageMinutes).toBeGreaterThan(25);

    const rel = entry?.relations[0];
    expect(rel?.kind).toBe('blocks');
    expect(rel?.dependsOnKey).toBe('ISS-9001');
    // cm:guard this pair is why the pool returns raw fields: `dropped` with a null merged_at and `reopen` WITH one both collapse to `satisfied:false`, and a master treats them differently. An assertion that only checked falsiness would still pass against the boolean this design deletes.
    expect(rel?.blockerStatus).toBe('dropped');
    expect(rel?.blockerMergedAt).toBeNull();
  });

  it('lets exactly one of two masters claim the same job', async () => {
    const { device, job } = await seed();
    const [a, b] = await Promise.all([
      mods.claimJobForMaster({ jobId: job, deviceId: device.id, sessionId: randomUUID() }),
      mods.claimJobForMaster({ jobId: job, deviceId: device.id, sessionId: randomUUID() }),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, reason: 'already_held' });
  });

  it('hides a held job, and shows it again once released', async () => {
    const { device, job } = await seed();
    const session = randomUUID();
    const claimed = await mods.claimJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: session,
    });
    expect(claimed.ok).toBe(true);

    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeUndefined();

    expect(await mods.releaseJobFromMaster({ jobId: job, sessionId: session })).toBe(true);

    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeDefined();
  });

  it('releases everything a dead master held', async () => {
    const { device, job } = await seed();
    const session = randomUUID();
    await mods.claimJobForMaster({ jobId: job, deviceId: device.id, sessionId: session });

    expect(await mods.releaseAllHeldBySession(session)).toBe(1);
    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeDefined();
  });

  it('does not offer a job whose parent run is terminal', async () => {
    const { device, job, run } = await seed();
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'completed' WHERE id = ${run}`);

    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeUndefined();
  });

  it('reaps a hold whose master went terminal, and leaves a live one alone', async () => {
    const { owner, project, device, run, job } = await seed();
    const deadSession = randomUUID();
    const liveSession = randomUUID();
    const secondJob = randomUUID();

    for (const [id, status] of [
      [deadSession, 'failed'],
      [liveSession, 'running'],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO agent_sessions (id, project_id, pipeline_run_id, user_id, device_id, status,
                                    last_heartbeat_at)
        VALUES (${id}, ${project.id}, ${run}, ${owner.id}, ${device.id}, ${status}, now())
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, queued_at,
                        held_by, held_at)
      SELECT ${secondJob}, project_id, pipeline_run_id, 'review', 'queued', created_by, now(),
             ${liveSession}, now()
      FROM jobs WHERE id = ${job}
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${deadSession}, held_at = now() WHERE id = ${job}
    `);

    expect(await mods.reapDeadMasterHolds()).toBe(1);

    const rows = (await harness.db.execute(sql`
      SELECT id, held_by FROM jobs WHERE id IN (${job}, ${secondJob})
    `)) as unknown as Array<{ id: string; held_by: string | null }>;

    expect(rows.find((r) => r.id === job)?.held_by).toBeNull();
    expect(rows.find((r) => r.id === secondJob)?.held_by).toBe(liveSession);
  });

  it('reaps a hold whose master stopped beating, however healthy its status reads', async () => {
    const { owner, project, device, run, job } = await seed();
    const silent = randomUUID();

    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, user_id, device_id, status,
                                  last_heartbeat_at)
      VALUES (${silent}, ${project.id}, ${run}, ${owner.id}, ${device.id}, 'running',
              now() - interval '10 minutes')
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${silent}, held_at = now() WHERE id = ${job}
    `);

    expect(await mods.reapDeadMasterHolds()).toBe(1);
    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeDefined();
  });

  it('separates pool depth from running, and surfaces the oldest running job', async () => {
    const { device, project, job } = await seed();

    const idle = await mods.readProjectLoad(project.id);
    expect(idle?.poolDepth).toBe(1);
    expect(idle?.jobsRunning).toBe(0);
    expect(idle?.oldestRunningMinutes).toBeNull();

    await harness.db.execute(sql`
      UPDATE jobs SET status = 'running', device_id = ${device.id},
                      dispatched_at = now() - interval '41 minutes'
      WHERE id = ${job}
    `);

    const busy = await mods.readProjectLoad(project.id);
    expect(busy?.jobsRunning).toBe(1);
    expect(busy?.poolDepth).toBe(0);
    expect(busy?.oldestRunningMinutes).toBeGreaterThan(38);
    expect(busy?.byType).toMatchObject({ code: 1 });

    const box = await mods.readDeviceLoad(device.id);
    expect(box?.jobsRunning).toBe(1);
    expect(box?.reposLocked).toContain('/tmp/pool-test');
  });
});
