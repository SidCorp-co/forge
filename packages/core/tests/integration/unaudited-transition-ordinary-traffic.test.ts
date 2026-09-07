/**
 * ISS-943 — the ordinary code paths that write a kernel status record NOTHING.
 *
 * ISS-943 corrected two of ISS-884's assertions here, and the correction is the
 * point rather than a detail. They proved `queued`→`dispatched` and
 * `running`→`paused` were uncounted — by performing them as raw SQL. Once the
 * detector counts any status change, raw SQL IS the intervention, so imitating
 * ordinary traffic with it asserted the opposite of what it claimed. Each one
 * now drives the real exported function.
 *
 * Positive twin: `unaudited-transition-detector.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDevice } from '../helpers/index.js';
import { createUnauditedFixture, type UnauditedFixture } from '../helpers/unaudited-fixture.js';

describe('unaudited transitions: ordinary code paths (ISS-943)', () => {
  let fx: UnauditedFixture;

  beforeAll(async () => {
    fx = await createUnauditedFixture();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fx.harness.cleanup();
  });
  beforeEach(() => fx.reset());

  it('records NOTHING when a terminal flip goes through applyKernelTransition', async () => {
    const jobId = await fx.insertJob('running');

    await fx.mods.applyKernelTransition(fx.harness.db as never, {
      entity: 'job',
      to: 'cancelled',
      fromStatus: 'running',
      where: sql`id = ${jobId} AND status = 'running'` as never,
      actor: { type: 'user', id: fx.ids.ownerId, agency: 'human' },
      reason: 'operator cancel',
      source: 'test',
    });

    expect(await fx.detected()).toHaveLength(0);
    const audit = await fx.harness.db.execute(sql`
      SELECT count(*)::int AS n FROM kernel_transitions WHERE entity_id = ${jobId}
    `);
    expect(Number((audit as unknown as Array<{ n: number }>)[0]?.n)).toBe(1);
  });

  // cm:guard drive the real `startJobForMaster`, never a raw-SQL imitation of it. This assertion was such an imitation until ISS-943, and once the detector counts any status change a raw-SQL imitation of ordinary traffic IS the intervention — so the imitation asserted the opposite of what it claimed.
  it('records nothing for the ordinary queued to dispatched stamp', async () => {
    const device = await createTestDevice(fx.harness.db, fx.ids.ownerId);
    const runnerId = randomUUID();
    await fx.harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, name, type)
      VALUES (${runnerId}, ${fx.ids.projectId}, ${device.id}, 'test-runner', 'claude-code')
    `);
    const sessionId = await fx.insertSession('running');
    const jobId = await fx.insertJob('queued');
    await fx.harness.db.execute(
      sql`UPDATE jobs SET held_by = ${sessionId}, held_at = now() WHERE id = ${jobId}`,
    );

    const result = await fx.mods.startJobForMaster({
      jobId,
      sessionId,
      deviceId: device.id,
    });

    expect(result.ok).toBe(true);
    expect(await fx.detected()).toHaveLength(0);
  });

  it('records nothing for an ordinary run pause and resume', async () => {
    await fx.mods.pauseRun({ runId: fx.ids.runId, pauseReason: 'test_pause' });
    await fx.mods.resumeRun({ runId: fx.ids.runId });

    const [row] = (await fx.harness.db.execute(
      sql`SELECT status FROM pipeline_runs WHERE id = ${fx.ids.runId}`,
    )) as unknown as Array<{ status: string }>;
    expect(row?.status).toBe('running');
    expect(await fx.detected()).toHaveLength(0);
  });

  it('records nothing for an ordinary held to queued resume', async () => {
    const jobId = await fx.insertJob('held');

    await expectDispatchToNotMatter(() =>
      fx.mods.resumeHeldJob(jobId, {
        actorId: fx.ids.ownerId,
        actorType: 'user',
        agency: 'human',
      } as never),
    );

    expect(await fx.detected()).toHaveLength(0);
  });

  /**
   * The overcount ISS-884 shipped, asserted as a regression.
   *
   * `trg_jobs_unaudited_transition` is `AFTER UPDATE OF status`; the I1
   * backstop is a `BEFORE` trigger that rewrites `NEW.status` to `cancelled`
   * when an active child is written under a terminal run. So an ordinary
   * resume of a held job whose run has closed used to be charged to
   * `direct_sql`: the requeue wrote `queued`, which stamped no marker because
   * only terminal writers stamped one, and I1 turned it terminal.
   *
   * On `origin/main` @ 2a4e95ac this fixture records one row. It must record
   * none, and the I1 audit row must still be there — the backstop is not being
   * disabled, only distinguished from a hand.
   */
  it('records nothing when the I1 backstop rewrites an ordinary requeue terminal', async () => {
    const jobId = await fx.insertJob('held');
    await fx.harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'completed' WHERE id = ${fx.ids.runId}`,
    );
    await fx.harness.db.execute(sql`DELETE FROM unaudited_transitions`);

    await expectDispatchToNotMatter(() =>
      fx.mods.resumeHeldJob(jobId, {
        actorId: fx.ids.ownerId,
        actorType: 'user',
        agency: 'human',
      } as never),
    );

    const [job] = (await fx.harness.db.execute(
      sql`SELECT status, failure_reason FROM jobs WHERE id = ${jobId}`,
    )) as unknown as Array<{ status: string; failure_reason: string | null }>;
    expect(job).toMatchObject({
      status: 'cancelled',
      failure_reason: 'orphan_under_terminal_run',
    });
    const [audit] = (await fx.harness.db.execute(sql`
      SELECT count(*)::int AS n FROM kernel_transitions
      WHERE entity_id = ${jobId} AND source = 'i1_trigger'
    `)) as unknown as Array<{ n: number }>;
    expect(Number(audit?.n)).toBe(1);

    expect(await fx.detected()).toHaveLength(0);
  });
});
/**
 * Run a lifecycle call whose post-commit dispatch needs a queue this suite does
 * not boot. The status flip has already committed by then, so swallowing the
 * enqueue failure measures the write and nothing else.
 */
async function expectDispatchToNotMatter(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }
}
