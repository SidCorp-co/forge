/**
 * `truncateAll` never empties the tables under an outbox delivery that is still running. A move's
 * commit wakes its consumers in-process, so in a file that starts the outbox worker a delivery can
 * still be writing when the next test's `beforeEach` truncates: core-integration on f9ec375d8 died
 * of exactly that (recovery-reason-e2e, 40P01 in truncateAll). Here the race is made certain: a real
 * delivery holds the last table TRUNCATE locks and waits, truncateAll starts, and the delivery then
 * asks for the first one, which TRUNCATE already holds.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { consumerOf, type Delivery } from '../../src/outbox/consumers.js';
import { emitEvent } from '../../src/outbox/index.js';
import { wakeConsumers } from '../../src/outbox/worker.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
  truncatedTables,
} from '../helpers/factories.js';

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const isDeadlock = (err: unknown): boolean =>
  JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})).includes('40P01') ||
  String((err as { cause?: { code?: string } })?.cause?.code) === '40P01';

/** Until TRUNCATE waits on a lock, or `ms` passes: the moment the old helper is inside the race. */
async function truncateWaitingOrAfter(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const [waiting] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE 'TRUNCATE%'
    `);
    if ((waiting?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('truncateAll and a delivery still running', () => {
  it('waits the delivery out instead of deadlocking against it', async () => {
    await truncateAll();
    const ownerId = (await createTestUser()).id;
    const projectId = (await createTestProject(ownerId)).id;
    const tables = (await truncatedTables()).map((t) => t.name);
    const first = tables[0] as string;
    const last = tables[tables.length - 1] as string;
    expect(first).not.toBe(last);

    const consumer = consumerOf('source.reviewed', 'review-note');
    if (!consumer) throw new Error('review-note is not registered for source.reviewed');
    const real = consumer.handle;

    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: { delivered: boolean; deadlock: boolean } = { delivered: false, deadlock: false };
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => {
      settled = resolve;
    });

    consumer.handle = async (_payload: unknown, delivery: Delivery) => {
      try {
        await delivery.inbox(async (tx) => {
          await tx.execute(sql.raw(`LOCK TABLE ${last} IN ROW EXCLUSIVE MODE`));
          started();
          await gate;
          await tx.execute(sql.raw(`LOCK TABLE ${first} IN ROW EXCLUSIVE MODE`));
        });
        seen.delivered = true;
      } catch (err) {
        if (isDeadlock(err)) seen.deadlock = true;
        throw err;
      } finally {
        settled();
      }
    };

    try {
      await emitEvent(db, 'source.reviewed', {
        projectId,
        issueId: null,
        reviewId: randomUUID(),
      } as never);
      wakeConsumers(['review-note']);
      await running;

      const truncating = truncateAll().then(
        () => null,
        (err: unknown) => err,
      );
      await truncateWaitingOrAfter(2_000);
      release();
      const failed = await truncating;
      await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 10_000))]);

      expect(
        failed === null ? false : isDeadlock(failed),
        'truncateAll deadlocked against the delivery it emptied the tables under',
      ).toBe(false);
      expect(failed).toBeNull();
      expect(seen.deadlock, 'the delivery was chosen as the deadlock victim').toBe(false);
      expect(seen.delivered, 'truncateAll waited the running delivery out').toBe(true);
    } finally {
      release();
      consumer.handle = real;
    }
  }, 60_000);
});
