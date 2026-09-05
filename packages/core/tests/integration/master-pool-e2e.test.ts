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

/**
 * Both acts of one claim, in the order a runner performs them.
 *
 * Written out rather than wrapped in production code on purpose: the whole
 * point of ISS-919 B2 is that nothing in core composes these two, so a helper
 * that lived in `claim.ts` would be the single verb the split removed.
 */
async function take(jobId: string, deviceId: string, sessionId: string) {
  const prepared = await mods.prepareJobForMaster({ jobId, deviceId, sessionId });
  if (!prepared.ok) return prepared;
  const started = await mods.startJobForMaster({ jobId, deviceId, sessionId });
  if (!started.ok) return started;
  return prepared;
}

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

    const refused = await take(second, device.id, randomUUID());
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe('issue_busy');

    const offered = await mods.readPool({ deviceId: device.id, limit: 20 });
    expect(offered.find((i) => i.jobId === second)).toBeUndefined();
  });

  it('separates a busy issue from a job another master already took', async () => {
    const { device, job } = await seed();
    const taken = await take(job, device.id, randomUUID());
    expect(taken.ok).toBe(true);

    const second = await take(job, device.id, randomUUID());
    expect(second.ok === false && second.reason).toBe('already_held');

    const missing = await take(randomUUID(), device.id, randomUUID());
    expect(missing.ok === false && missing.reason).toBe('not_found');
  });

  it('lets exactly one of two masters claim the same job', async () => {
    const { device, job } = await seed();
    const [a, b] = await Promise.all([
      take(job, device.id, randomUUID()),
      take(job, device.id, randomUUID()),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false, reason: 'already_held' });
  });

  // cm:guard the pool must hide a job for BOTH reasons it can be unavailable, and they are now different rows: a claimed job is hidden because it is no longer `queued`, a mid-claim one because somebody holds it. Testing only the first would pass against a pool that ignores `held_by` entirely, and two masters would then prepare the same job.
  it('hides a claimed job, and hides a mid-claim hold too', async () => {
    const { device, job } = await seed();
    const claimed = await take(job, device.id, randomUUID());
    expect(claimed.ok).toBe(true);
    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeUndefined();

    const { device: d2, job: j2 } = await seed();
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${randomUUID()}, held_at = now() WHERE id = ${j2}
    `);
    expect(
      (await mods.readPool({ deviceId: d2.id, limit: 20 })).find((i) => i.jobId === j2),
    ).toBeUndefined();
  });

  // cm:guard the only jobs a dead master still holds are ones it never got started — a claim that reached its stamp released the hold in the same statement. Seeding by hand is what keeps this covering the window that remains rather than one that no longer exists.
  it('releases everything a dead master was still holding', async () => {
    const { device, job } = await seed();
    const session = randomUUID();
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${session}, held_at = now() WHERE id = ${job}
    `);

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

    const result = await take(retry, device.id, randomUUID());

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

    const result = await take(job, device.id, randomUUID());
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

  // cm:guard THE regression, and the second half is the whole assertion. A claim that leaves the hold set is a claim the reaper can undo underneath a live agent: measured on epodsystem 2026-09-05, jobs f7f4bce4 and 8b8b7be4 were re-queued with device_id NULL while their agents ran on, and every event they posted came back 403 at 2/s with nothing able to stop them. It needs no dead master — the session-less arm judges by `held_at` age alone, and `runner.start` is documented to block for minutes.
  // cm:guard this test is the only thing between a version skew and unreviewed work on `main`. A box below the floor resolves no worktree branch, takes the `owns_root` path, runs the agent IN THE REPO ROOT on the base branch, and reports success — silent in the worst direction. Raising the floor without keeping a case at the old version turns the refusal back into that.
  it('refuses a claim from a runner too old to name its agent, by name and without a hold', async () => {
    const { device, job } = await seed();
    await harness.db.execute(
      sql`UPDATE devices SET agent_version = '0.10.5' WHERE id = ${device.id}`,
    );
    const result = await take(job, device.id, randomUUID());
    expect(result).toEqual({ ok: false, reason: 'runner_too_old' });
    const [row] = (await harness.db.execute(
      sql`SELECT status, held_by, device_id FROM jobs WHERE id = ${job}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('queued');
    expect(row?.held_by).toBeNull();
    expect(row?.device_id).toBeNull();
  });

  it('keeps the stamp when the reaper sweeps a claim old enough to look abandoned', async () => {
    const { device, job } = await seed();

    const result = await take(job, device.id, randomUUID());
    expect(result.ok).toBe(true);

    await harness.db.execute(sql`
      UPDATE jobs SET held_at = now() - interval '10 minutes' WHERE id = ${job}
    `);
    expect(await mods.reapDeadMasterHolds()).toBe(0);

    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id, dispatched_at, held_by FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('dispatched');
    expect(row?.device_id).toBe(device.id);
    expect(row?.dispatched_at).not.toBeNull();
    expect(row?.held_by).toBeNull();
  });

  // cm:guard the hold ends WITH the stamp, in one statement, so nothing is left for a release to find. A release that still had a claimed job to act on would be a release able to re-queue a running one.
  it('leaves a claimed job with no hold for any release path to take', async () => {
    const { device, job } = await seed();
    const session = randomUUID();

    await take(job, device.id, session);

    expect(await mods.releaseJobFromMaster({ jobId: job, sessionId: session })).toBe(false);
    expect(await mods.releaseAllHeldBySession(session)).toBe(0);
    expect(await mods.releaseHoldsForSession(session)).toBe(0);

    const [row] = (await harness.db.execute(sql`
      SELECT status, device_id, attempts FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.status).toBe('dispatched');
    expect(row?.device_id).toBe(device.id);
    // cm:guard a claim is NOT an attempt — a master choosing an order must not spend an issue's retry budget.
    expect(Number(row?.attempts)).toBe(1);
  });

  // cm:guard the hold still has to be reapable in the window it exists in: between the claim's own UPDATE and the stamp, `prepareClaimedJob` runs and can throw or hang. Seed that shape by hand — a completed claim can no longer produce it, which is the point.
  it('reaps a mid-claim hold whose master never had a session row at all', async () => {
    const { device, job } = await seed();
    const ghost = randomUUID();

    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${ghost}, held_at = now() - interval '10 minutes'
      WHERE id = ${job}
    `);

    expect(await mods.reapDeadMasterHolds()).toBe(1);

    const [row] = (await harness.db.execute(sql`
      SELECT status, held_by, device_id FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.held_by).toBeNull();
    expect(row?.status).toBe('queued');
    expect(row?.device_id).toBeNull();
    expect(
      (await mods.readPool({ deviceId: device.id, limit: 20 })).find((i) => i.jobId === job),
    ).toBeDefined();
  });

  // cm:guard the `held_at` bound is what makes judging a session-less holder safe. Without it a master mid-preparation has its job taken the instant it takes it, because a holder with no session row always looks dead.
  it('leaves a fresh session-less hold alone', async () => {
    const { job } = await seed();
    await harness.db.execute(sql`
      UPDATE jobs SET held_by = ${randomUUID()}, held_at = now() WHERE id = ${job}
    `);

    expect(await mods.reapDeadMasterHolds()).toBe(0);

    const [row] = (await harness.db.execute(sql`
      SELECT held_by, status FROM jobs WHERE id = ${job}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row?.held_by).not.toBeNull();
    expect(row?.status).toBe('queued');
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
