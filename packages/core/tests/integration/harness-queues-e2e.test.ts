/**
 * The integration harness declares every queue an outbox consumer sends to, as the server's boot
 * does. `memory-reconcile` sends a pg-boss job when an issue's move lands its merge
 * (`memory/reconcile.ts:registerMemoryReconcileTrigger`), and the harness's `startQueue` declared no
 * such queue: the delivery failed, retried behind its backoff, and a test that closed an issue and
 * then waited on the outbox stalled about 45 s (ISS-760 declared it in its own test). Against real
 * Postgres and pg-boss.
 *
 * @direct-test-of packages/core/tests/helpers/ecosystem-world.ts
 * @direct-test-of packages/core/src/memory/reconcile.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { emitEvent } from '../../src/outbox/index.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('the harness queue', () => {
  it('settles an issue closed by its landing within seconds, the reconcile job queued', async () => {
    const owner = await createTestUser({ verified: true });
    const { id: projectId } = await createTestProject(owner.id);
    const issue = await createTestIssue(projectId, owner.id, 1, {
      status: 'closed',
      createdAt: new Date(),
      mergedAt: new Date(),
    });
    await emitEvent(db, 'issue.transitioned', {
      entity: 'issue',
      id: issue.id,
      projectId,
      issueId: issue.id,
      from: 'awaiting_release',
      to: 'closed',
      machineVersion: 1,
      reason: null,
      actor: { type: 'user', id: owner.id, agency: 'agent' },
      at: new Date().toISOString(),
    });
    const started = Date.now();
    await settleOutbox(15_000);
    expect(
      Date.now() - started,
      'the outbox stalled behind a queue the harness never declared',
    ).toBeLessThan(5_000);
    const [queued] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pgboss_v12.job
       WHERE name = 'memory-reconcile' AND data->>'issueId' = ${issue.id}`)) as unknown as Array<{
      n: number;
    }>;
    const failed = (await db.execute(sql`
      SELECT name, state, output::text AS said FROM pgboss_v12.job
       WHERE name LIKE 'outbox.%' AND state IN ('retry', 'failed')`)) as unknown as Array<{
      name: string;
      state: string;
      said: string;
    }>;
    expect(failed, 'an outbox delivery failed and waits on its retry').toEqual([]);
    expect(queued?.n).toBe(1);
  });
});
