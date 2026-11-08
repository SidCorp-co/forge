/**
 * Migration 0642, run by drizzle's own migrator (ISS-822, REQ-12 BC-18): `source.merged` leaves the
 * outbox. Its rows, which no consumer read since ISS-774, leave with its type row; a pg-boss job
 * still waiting to deliver one aborts the deploy by name instead.
 *
 * @direct-test-of packages/core/drizzle/migrations/0642_a_merge_the_host_reports_is_no_outbox_event.sql
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0642_a_merge_the_host_reports_is_no_outbox_event';

let ground: MigrationGround;
let m: MigrationDb;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  await m.sql`
    INSERT INTO pipeline_outbox (type, payload)
    VALUES ('source.merged', ${m.sql.json({ commitSha: 'a'.repeat(40) })}),
           ('source.pushed', ${m.sql.json({ commit: 'b'.repeat(40) })})`;
});

afterEach(async () => {
  await m.drop();
});

/** The migrator's refusal with the database's own message, which drizzle carries as the cause. */
async function refusalOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'it ran';
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
}

const types = async () =>
  (await m.sql<{ type: string }[]>`SELECT type FROM outbox_event_types WHERE type LIKE 'source.%' ORDER BY type`).map(
    (r) => r.type,
  );

describe('0642: a merge the host reports is no outbox event', () => {
  it('retires the type and the rows nothing read, keeping every other event', async () => {
    await m.migrate();

    expect(await types()).toEqual(['source.pushed', 'source.reviewed']);
    const left = await m.sql<{ type: string }[]>`SELECT type FROM pipeline_outbox ORDER BY type`;
    expect(left.map((r) => r.type)).toEqual(['source.pushed']);
  });

  it('aborts naming the jobs still waiting to deliver one, and retires nothing', async () => {
    await m.sql`CREATE SCHEMA IF NOT EXISTS pgboss_v12`;
    await m.sql`CREATE TABLE IF NOT EXISTS pgboss_v12.job (id uuid, state text, data jsonb)`;
    await m.sql`
      INSERT INTO pgboss_v12.job (id, state, data)
      VALUES (gen_random_uuid(), 'retry', ${m.sql.json({ type: 'source.merged' })}),
             (gen_random_uuid(), 'completed', ${m.sql.json({ type: 'source.merged' })})`;

    expect(await refusalOf(m.migrate())).toMatch(
      /OUTBOX_TYPE_STILL_DELIVERED: 1 pg-boss job\(s\) still wait to deliver a source\.merged event/,
    );
    expect(await types()).toContain('source.merged');
  });
});
