/**
 * ISS-652 — A3 (`runner_starved`) against real Postgres.
 *
 * A3's claim is narrow: the job would dispatch RIGHT NOW if a runner could take
 * it. Every case here is therefore a pair — the discriminating "does not fire"
 * cases matter more than the firing ones, because a false positive on a queue
 * the dispatcher is correctly holding is what makes an ops alert ignorable.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_NAMING_MIN_RUNNER } from '../../src/runners/device-cap.js';
import { type AlertApp, findAlert, getAlerts, setupAlertApp } from '../helpers/alert-app.js';
import { type AlertFixtures, alertFixtures } from '../helpers/alert-fixtures.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/index.js';

/** One old queued job plus one runner in the state under test. */
async function seedQueueAndRunner(
  ctx: AlertApp,
  fx: AlertFixtures,
  runner: Partial<Parameters<AlertFixtures['insertRunner']>[0]>,
): Promise<{ projectId: string; runnerId: string }> {
  const owner = await createTestUser(ctx.harness.db);
  const project = await createTestProject(ctx.harness.db, owner.id);
  const run = await fx.insertRun(project.id, 'running');
  await fx.insertJob({
    projectId: project.id,
    runId: run,
    status: 'queued',
    queuedAgoMinutes: 10,
  });
  const runnerId = await fx.insertRunner({
    projectId: project.id,
    status: 'online',
    ...runner,
  });
  return { projectId: project.id, runnerId };
}

/** Issue A running on `runnerId`, issue B queued behind it. */
async function seedTwoIssuesOneBusyRunner(
  fx: AlertFixtures,
  projectId: string,
  ownerId: string,
  runnerId: string,
): Promise<void> {
  const run = await fx.insertRun(projectId, 'running');
  const issueA = await fx.insertIssue({ projectId, createdById: ownerId, seq: 1 });
  const issueB = await fx.insertIssue({ projectId, createdById: ownerId, seq: 2 });
  await fx.insertJob({
    projectId,
    runId: run,
    issueId: issueA,
    status: 'running',
    runnerId,
    dispatchedAgoMinutes: 1,
  });
  await fx.insertJob({
    projectId,
    runId: run,
    issueId: issueB,
    status: 'queued',
    queuedAgoMinutes: 10,
  });
}

describe('A3 runner starvation (ISS-652)', () => {
  let ctx: AlertApp;
  let fx: AlertFixtures;

  beforeAll(async () => {
    ctx = await setupAlertApp();
    fx = alertFixtures(ctx.harness);
  }, 120_000);

  afterAll(async () => {
    if (ctx?.harness) await ctx.harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(ctx.harness.db);
  });

  // cm:guard every state below is one the dispatcher's `fresh_capable_runners` CTE rejects while `status = 'online'` still reads healthy, so a copy of that CTE missing any one clause reports `ok` on a genuinely wedged queue. `limit_reason='auth'` and `provision_status` reached main while A3 hand-rolled its own filter — these two cases are that regression.
  it.each([
    ['quarantined (AC 7)', { quarantinedUntil: new Date(Date.now() + 3_600_000).toISOString() }],
    ['heartbeat is stale', { lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() }],
    ['rate-limited', { rateLimitedUntil: new Date(Date.now() + 3_600_000).toISOString() }],
    ['auth-limited, so the rate-limit clause passes it', { limitReason: 'auth' }],
    ['provisioning, not ready', { provisionStatus: 'provisioning' }],
  ])('fires when the only runner is online but %s', async (_label, runnerState) => {
    const { runnerId } = await seedQueueAndRunner(ctx, fx, runnerState);

    const token = await ctx.adminToken();
    const { body } = await getAlerts(ctx, token);
    const a3 = findAlert(body, 'A3');
    expect(a3?.status).not.toBe('ok');
    expect(a3?.count).toBeGreaterThanOrEqual(1);

    await ctx.harness.db.execute(sql`
      UPDATE runners
      SET quarantined_until = NULL, rate_limited_until = NULL, limit_reason = NULL,
          provision_status = 'ready', last_seen_at = now()
      WHERE id = ${runnerId}
    `);
    const { body: cleared } = await getAlerts(ctx, token);
    expect(findAlert(cleared, 'A3')?.status).toBe('ok');
  });

  it('fires when no runner satisfies the queued job capabilities', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const run = await fx.insertRun(project.id, 'running');
    await fx.insertRunner({
      projectId: project.id,
      status: 'online',
      capabilities: { gpu: false },
    });
    await fx.insertJob({
      projectId: project.id,
      runId: run,
      status: 'queued',
      queuedAgoMinutes: 10,
      payload: { requiredCapabilities: { gpu: true } },
    });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A3')?.status).not.toBe('ok');
  });

  // cm:guard `->` on a JSON null yields jsonb 'null', not SQL NULL, so a coalesce with no nullif leaves `@> 'null'` matching no runner at all. dispatcher.ts reads the same field with `?? {}` and places the job on this very runner, so a fire here is pure noise on a queue that is moving.
  it('stays ok when the queued job carries an explicitly null requiredCapabilities', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const run = await fx.insertRun(project.id, 'running');
    await fx.insertRunner({ projectId: project.id, status: 'online' });
    await fx.insertJob({
      projectId: project.id,
      runId: run,
      status: 'queued',
      queuedAgoMinutes: 10,
      payload: { requiredCapabilities: null },
    });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A3')?.status).toBe('ok');
  });

  // cm:guard the per-stage device pool is applied by onlineCapableDeviceIds and by NOTHING in the picker's CTE, so a pool naming only devices that are gone leaves every gate passing and the job unplaceable — a wedge with no gate reason for any UI to show, which is the case A3 exists to name
  it('fires when the stage device pool names no runner the project has', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    await ctx.harness.db.execute(sql`
      UPDATE projects
      SET agent_config = '{"pipelineConfig":{"states":{"approved":{"deviceIds":["11111111-1111-4111-8111-111111111111"]}}}}'::jsonb
      WHERE id = ${project.id}
    `);
    const run = await fx.insertRun(project.id, 'running');
    await fx.insertRunner({ projectId: project.id, status: 'online' });
    await fx.insertJob({
      projectId: project.id,
      runId: run,
      status: 'queued',
      queuedAgoMinutes: 10,
      payload: { stageStatus: 'approved' },
    });

    const token = await ctx.adminToken();
    const { body } = await getAlerts(ctx, token);
    expect(findAlert(body, 'A3')?.status).not.toBe('ok');

    // cm:why an EMPTY pool means "the whole fleet", not "no device" — clearing it must clear the alert, which is what separates this from a plain no-runner case
    await ctx.harness.db.execute(sql`
      UPDATE projects
      SET agent_config = '{"pipelineConfig":{"states":{"approved":{"deviceIds":[]}}}}'::jsonb
      WHERE id = ${project.id}
    `);
    const { body: cleared } = await getAlerts(ctx, token);
    expect(findAlert(cleared, 'A3')?.status).toBe('ok');
  });

  // cm:guard `z.uuid()` accepts uppercase hex and nothing normalizes it, but `device_id::text` on a uuid column always renders lowercase — so comparing as text matches nothing here while runners/select.ts, binding a parameter against the uuid column, matches fine. This runner IS in the pool and IS dispatchable; A3 saying otherwise would page every platform admin about a moving queue.
  it('stays ok when the stage pool names this runner in uppercase hex', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const deviceId = '22222222-2222-4222-8222-222222222222';
    // cm:guard bind the version to the floor constant, never a literal — this fixture is hand-rolled rather than `createTestDevice`, and a device below the claim floor is invisible to `fresh_capable_runners`, which would make this uppercase-hex assertion pass or fail for a reason that has nothing to do with hex.
    await ctx.harness.db.execute(sql`
      INSERT INTO devices (id, owner_id, name, platform, token_hash, token_prefix, status, agent_version)
      VALUES (${deviceId}, ${owner.id}, 'pool fixture', 'linux', 'x', 'pooltest', 'online',
              ${AGENT_NAMING_MIN_RUNNER})
    `);
    await ctx.harness.db.execute(sql`
      UPDATE projects
      SET agent_config = ${JSON.stringify({
        pipelineConfig: { states: { approved: { deviceIds: [deviceId.toUpperCase()] } } },
      })}::jsonb
      WHERE id = ${project.id}
    `);
    const run = await fx.insertRun(project.id, 'running');
    const runnerId = await fx.insertRunner({ projectId: project.id, status: 'online' });
    await ctx.harness.db.execute(
      sql`UPDATE runners SET device_id = ${deviceId} WHERE id = ${runnerId}`,
    );
    await fx.insertJob({
      projectId: project.id,
      runId: run,
      status: 'queued',
      queuedAgoMinutes: 10,
      payload: { stageStatus: 'approved' },
    });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A3')?.status).toBe('ok');
  });

  // cm:why cap=2 so issue B PASSES project_cap and the sole runner being full is the only thing left holding it — genuine capacity starvation, which no upstream gate clears
  // cm:guard a BUSY runner is not a starved queue, and this is the case that proves A3 knows the difference. Core enforces no ceiling — a box already running a job still claims the next one — so a capacity term in A3's runner EXISTS would report every project whose runners are working, page every platform admin at three of them, and bury the wedge the alert exists to name. The fixture is the alarming one with only the runner's load changed.
  it('stays ok when the only runner is healthy but already running a job', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const runnerId = await fx.insertRunner({ projectId: project.id, status: 'online' });
    await seedTwoIssuesOneBusyRunner(fx, project.id, owner.id, runnerId);

    const token = await ctx.adminToken();
    const { body } = await getAlerts(ctx, token);
    expect(findAlert(body, 'A3')?.status).toBe('ok');
  });

  // cm:guard the discriminating case for `held_by`: a job a master has already claimed is NOT starved — a master is holding it precisely because it means to run it, and counting that as "no usable runner" alarms on the healthy path. The fixture is otherwise identical to the alarming one, so a pass proves the hold is replayed rather than the runner state alone being read.
  it('stays ok when the queued job is already claimed by a master', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const runnerId = await fx.insertRunner({ projectId: project.id, status: 'online' });
    await seedTwoIssuesOneBusyRunner(fx, project.id, owner.id, runnerId);
    await ctx.harness.db.execute(
      sql`UPDATE jobs SET held_by = gen_random_uuid(), held_at = now() WHERE status = 'queued'`,
    );

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A3')?.status).toBe('ok');
  });

  // cm:guard this used to assert `ok`, on the `stale_trigger` gate arm that explained the wait away. ISS-895 deleted the arm AND the lane, so a queued job of a retired type is now exactly what A3 is for: no runner may claim `code` (it is absent from RUNNER_CAPABILITIES), nothing ends the job, and it sits queued forever. Reporting `ok` here would tell a platform admin the queue is healthy about the one row that can never move.
  it('warns when a queued job names a job type no runner can claim', async () => {
    const owner = await createTestUser(ctx.harness.db);
    const project = await createTestProject(ctx.harness.db, owner.id);
    const run = await fx.insertRun(project.id, 'running');
    const issueId = await fx.insertIssue({
      projectId: project.id,
      createdById: owner.id,
      seq: 1,
      status: 'developed',
    });
    await fx.insertJob({
      projectId: project.id,
      runId: run,
      status: 'queued',
      type: 'code',
      issueId,
      payload: { stageStatus: 'approved' },
      queuedAgoMinutes: 10,
    });

    const { body } = await getAlerts(ctx, await ctx.adminToken());
    expect(findAlert(body, 'A3')?.status).toBe('warn');
  });
});
