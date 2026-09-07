/**
 * ISS-943 — the properties `forge.kernel_txn` has to have for the detector to
 * mean anything: it suppresses a wrapped write, it reaches FK-cascaded children,
 * and it is scoped to one transaction and not to the connection.
 *
 * Where the writer is a route rather than an exported function (the session
 * PATCH, the two cascading deletes) this file asserts the MECHANISM and
 * `src/db/kernel-marker-guard.test.ts` asserts statically that those routes are
 * inside one. Neither half is sufficient alone and the pair is; said out loud
 * because a reader looking for `DELETE /api/projects/:id` here will not find it.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUnauditedFixture, type UnauditedFixture } from '../helpers/unaudited-fixture.js';

describe('unaudited transitions: the marker itself (ISS-943)', () => {
  let fx: UnauditedFixture;

  beforeAll(async () => {
    fx = await createUnauditedFixture();
  }, 60_000);
  afterAll(async () => {
    if (fx) await fx.harness.cleanup();
  });
  beforeEach(() => fx.reset());

  it('records NOTHING when a SESSION terminal flip goes through applyKernelTransition', async () => {
    const sessionId = await fx.insertSession('running');

    await fx.mods.applyKernelTransition(fx.harness.db as never, {
      entity: 'session',
      to: 'completed',
      fromStatus: 'running',
      where: sql`id = ${sessionId} AND status = 'running'` as never,
      actor: { type: 'runner' },
      reason: 'finished',
      source: 'test',
    });

    expect(await fx.detected()).toHaveLength(0);
  });

  it('records nothing for a session status write inside withKernelMarker', async () => {
    const sessionId = await fx.insertSession('running');

    await fx.mods.withKernelMarker(
      fx.harness.db as never,
      async (tx) =>
        tx.execute(
          sql`UPDATE agent_sessions SET status = 'completed' WHERE id = ${sessionId}`,
        ) as never,
    );

    expect(await fx.detected()).toHaveLength(0);
  });

  it('records nothing when a marked parent DELETE cascades all three kernel tables', async () => {
    await fx.insertJob('running');
    await fx.insertSession('running');

    await fx.mods.withKernelMarker(
      fx.harness.db as never,
      async (tx) => tx.execute(sql`DELETE FROM projects WHERE id = ${fx.ids.projectId}`) as never,
    );

    const [remaining] = (await fx.harness.db.execute(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE id = ${fx.ids.runId}`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(remaining?.n)).toBe(0);
    expect(await fx.detected()).toHaveLength(0);
  });

  it('records nothing when a marked issue DELETE cascades its runs', async () => {
    await fx.mods.withKernelMarker(
      fx.harness.db as never,
      async (tx) => tx.execute(sql`DELETE FROM issues WHERE id = ${fx.ids.issueId}`) as never,
    );

    const [remaining] = (await fx.harness.db.execute(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE id = ${fx.ids.runId}`,
    )) as unknown as Array<{ n: number }>;
    expect(Number(remaining?.n)).toBe(0);
    expect(await fx.detected()).toHaveLength(0);
  });

  // cm:guard the marker is transaction-LOCAL (`set_config(..., true)`), and this is the assertion that proves it. A session-scoped stamp would still be set on the next statement the pooled connection served, so one app write would silence every hand-written flip that followed it down the same connection — the instrument would read zero and look healthy.
  it('does not silence a hand-written flip that follows a marked write', async () => {
    const marked = await fx.insertJob('running');
    const byHand = await fx.insertJob('running', { type: 'review' });

    await fx.mods.withKernelMarker(
      fx.harness.db as never,
      async (tx) => tx.execute(sql`UPDATE jobs SET status = 'done' WHERE id = ${marked}`) as never,
    );
    await fx.harness.db.execute(sql`UPDATE jobs SET status = 'done' WHERE id = ${byHand}`);

    const rows = await fx.detected();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_id).toBe(byHand);
  });
});
