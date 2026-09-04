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

let harness: TestDatabase;
let mods: {
  readPool: typeof import('../../src/devices/pool.js').readPool;
  claimJobForMaster: typeof import('../../src/devices/claim.js').claimJobForMaster;
  releaseJobFromMaster: typeof import('../../src/devices/claim.js').releaseJobFromMaster;
  releaseAllHeldBySession: typeof import('../../src/devices/claim.js').releaseAllHeldBySession;
  readDeviceLoad: typeof import('../../src/devices/load.js').readDeviceLoad;
  readProjectLoad: typeof import('../../src/devices/load.js').readProjectLoad;
  readFleetLoad: typeof import('../../src/devices/load.js').readFleetLoad;
  reapDeadMasterHolds: typeof import('../../src/devices/master-reaper.js').reapDeadMasterHolds;
  releaseHoldsForSession: typeof import('../../src/devices/master-reaper.js').releaseHoldsForSession;
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
    readFleetLoad: load.readFleetLoad,
    reapDeadMasterHolds: reaper.reapDeadMasterHolds,
    releaseHoldsForSession: reaper.releaseHoldsForSession,
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

  return { owner, project, device, run, job, issue };
}

describe('master pool', () => {
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

  // cm:guard L1 is the ONLY correctness gate the master cannot be trusted with, so it needs a test that fails when the NOT EXISTS is dropped. `jobs_active_unique` is on (issue_id, type), so the two jobs here are deliberately DIFFERENT types — a same-type pair is refused by the index and would pass this test with the gate deleted.
  it('refuses a second step for an issue that already has one in flight', async () => {
    const { owner, project, device, run, issue } = await seed();
    const second = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, queued_at)
      VALUES (${second}, ${project.id}, ${issue}, ${run}, 'review', 'queued', ${owner.id}, now())
    `);
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'running' WHERE id IN (
        SELECT id FROM jobs WHERE issue_id = ${issue} AND type = 'code'
      )
    `);

    const refused = await mods.claimJobForMaster({
      jobId: second,
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('issue_busy');

    const offered = await mods.readPool({ deviceId: device.id, limit: 20 });
    expect(offered.find((i) => i.jobId === second)).toBeUndefined();
  });

  it('separates a busy issue from a job another master already took', async () => {
    const { device, job } = await seed();
    const taken = await mods.claimJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(taken.ok).toBe(true);

    const second = await mods.claimJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(second.ok === false && second.reason).toBe('already_held');

    const missing = await mods.claimJobForMaster({
      jobId: randomUUID(),
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(missing.ok === false && missing.reason).toBe('not_found');
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
});

// cm:guard the reaper cases live in their own block so the shared setup is not counted against either one twice — they also assert the OPPOSITE property from the pool cases above: that a hold is taken BACK, which is the half that has no caller to notice when it breaks.
describe('master pool — reaping, load and preparation', () => {
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

  // cm:guard a fault flag must reach the master RAW. `fresh_capable_runners` used to exclude an `auth` runner from dispatch by name, and nothing excludes it now — so if this stops being reported, a master hands work to a box whose Claude session is dead and learns only from the failure.
  it('reports a runner fault verbatim rather than hiding the box', async () => {
    const { project, device } = await seed();
    await harness.db.execute(sql`
      UPDATE runners SET limit_reason = 'auth', rate_limited_until = NULL
      WHERE project_id = ${project.id} AND device_id = ${device.id}
    `);

    const load = await mods.readDeviceLoad(device.id);
    expect(load?.runnerFaults).toHaveLength(1);
    expect(load?.runnerFaults[0]?.limitReason).toBe('auth');
    expect(load?.runnerFaults[0]?.until).toBeNull();

    const fleet = await mods.readFleetLoad(project.id, 120);
    expect(fleet.find((e) => e.deviceId === device.id)?.runnerFaults[0]?.limitReason).toBe('auth');
  });

  // cm:guard a retry clone carries NO `agent_session_id`, so it is the ONE claim that always walks the create path in `ensureAgentSessionForJob` — and that function answers null on any failure, which `prepareClaimedJob` turns into a throw that releases the hold. A throw there is not a refusal: the job goes straight back to the pool for the next master to claim and throw on again, forever, with no attempt counter in the way. This test is what says that path completes.
  it('prepares a retry clone, which arrives with no session of its own', async () => {
    const { owner, project, device, run, job, issue } = await seed();
    const retry = randomUUID();

    await harness.db.execute(sql`
      UPDATE jobs SET status = 'failed', finished_at = now() WHERE id = ${job}
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by,
                        queued_at, retry_of, attempts, agent_session_id)
      VALUES (${retry}, ${project.id}, ${issue}, ${run}, 'code', 'queued', ${owner.id}, now(),
              ${job}, 1, NULL)
    `);

    const result = await mods.claimJobForMaster({
      jobId: retry,
      deviceId: device.id,
      sessionId: randomUUID(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.agentSessionId).toBeTruthy();
    expect(result.prepared.attempts).toBe(1);
    // cm:guard identity comes from the PREPARATION, not from the pool entry the master was holding — the runner has nothing else to name the job by.
    expect(result.prepared.jobId).toBe(retry);
    expect(result.prepared.projectId).toBe(project.id);
    expect(result.prepared.issueId).toBe(issue);
    expect(result.prepared.type).toBe('code');

    const [row] = (await harness.db.execute(sql`
      SELECT agent_session_id FROM jobs WHERE id = ${retry}
    `)) as unknown as Array<{ agent_session_id: string | null }>;
    expect(row?.agent_session_id).toBe(result.prepared.agentSessionId);
  });

  // cm:guard the four columns the RUNNER's own routes gate on. `lifecycle-routes.ts`, `events-routes.ts` and `turn-verdict-routes.ts` each 403 unless `jobs.device_id` matches the calling device, and ack additionally requires `status IN ('dispatched','running')` — so a claim that stamps neither starts a process core refuses to talk to. Measured live on 2026-09-05: two jobs ran on the correct repos and every ack and event came back 403 Forbidden.
  it('stamps the job onto the box, in the four columns the runner is gated by', async () => {
    const { device, job, project } = await seed();

    const result = await mods.claimJobForMaster({
      jobId: job,
      deviceId: device.id,
      sessionId: randomUUID(),
    });
    expect(result.ok).toBe(true);

    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id, runner_id, dispatched_at FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('dispatched');
    expect(row?.device_id).toBe(device.id);
    expect(row?.dispatched_at).not.toBeNull();

    const [runner] = (await harness.db.execute(sql`
      SELECT id FROM runners WHERE project_id = ${project.id} AND device_id = ${device.id}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.runner_id).toBe(runner?.id);
  });

  // cm:guard a release must leave the job as claimable as it found it. Clearing the hold while leaving `dispatched` + a device_id behind is worse than not releasing at all: the pool skips it, no master can take it, and no process exists to finish it.
  it('unwinds the stamp when a master lets go before the runner acked', async () => {
    const { device, job } = await seed();
    const session = randomUUID();

    await mods.claimJobForMaster({ jobId: job, deviceId: device.id, sessionId: session });
    expect(await mods.releaseJobFromMaster({ jobId: job, sessionId: session })).toBe(true);

    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id, dispatched_at, held_by, attempts FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('queued');
    expect(row?.device_id).toBeNull();
    expect(row?.dispatched_at).toBeNull();
    expect(row?.held_by).toBeNull();
    // cm:guard a release is NOT a failure — spending an attempt on "I changed my mind about the order" burns an issue's retry budget on something that never went wrong.
    expect(Number(row?.attempts)).toBe(1);

    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeDefined();
  });

  // cm:guard an ACKED job keeps its stamp when its master goes. The agent process is setsid-detached and outlives the master that started it, so returning the row to `queued` would offer a second box work that is already running — two agents, one worktree.
  it('leaves an acked job running when its master dies, and reclaims an unacked one', async () => {
    const { device, job, project, owner, run } = await seed();
    const session = randomUUID();
    const acked = randomUUID();

    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, queued_at,
                        device_id, dispatched_at, acked_at, held_by)
      VALUES (${acked}, ${project.id}, ${run}, 'review', 'dispatched', ${owner.id}, now(),
              ${device.id}, now(), now(), ${session})
    `);
    await mods.claimJobForMaster({ jobId: job, deviceId: device.id, sessionId: session });

    expect(await mods.releaseHoldsForSession(session)).toBe(2);

    const rows = (await harness.db.execute(sql`
      SELECT id, status, device_id FROM jobs WHERE id IN (${job}, ${acked})
    `)) as unknown as Array<Record<string, unknown>>;
    const unacked = rows.find((r) => r.id === job);
    const live = rows.find((r) => r.id === acked);
    expect(unacked?.status).toBe('queued');
    expect(unacked?.device_id).toBeNull();
    expect(live?.status).toBe('dispatched');
    expect(live?.device_id).toBe(device.id);
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
