/**
 * ISS-1342 — pg-boss 10 to 12 against a real Postgres.
 *
 * Each case seeds a schema with the pg-boss 10 release core ran until this change (the
 * `pg-boss-v10` alias), boots core's `bootBoss` on pg-boss 12 against it, and reads both schemas
 * back. A schema of its own per case, so no case reads another's queue.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import PgBossV10 from 'pg-boss-v10';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootBoss } from '../../src/queue/boss.js';
import { BossSchemaRefusal, bossSchemas } from '../../src/queue/v10-carry.js';
import { setupTestDatabase, type TestDatabase } from '../helpers/index.js';

let harness: TestDatabase;
let sql: pg.Client;
const opened: PgBoss[] = [];

beforeAll(async () => {
  harness = await setupTestDatabase();
  sql = new pg.Client({ connectionString: harness.url });
  await sql.connect();
}, 60_000);

/** A pg-boss 12 left running is a `pgboss` session the next case's set-aside would count. */
afterEach(async () => {
  for (const queue of opened.splice(0)) await queue.stop({ graceful: false }).catch(() => {});
});

afterAll(async () => {
  await sql?.end().catch(() => {});
  if (harness) await harness.cleanup();
});

function freshSchema(): string {
  return `pgboss_t${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function v12(schema: string): PgBoss {
  const queue = new PgBoss({
    connectionString: harness.url,
    schema,
    supervise: false,
    schedule: false,
  });
  queue.on('error', () => {});
  opened.push(queue);
  return queue;
}

async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await sql.query(text, values)).rows as T[];
}

interface Seeded {
  queued: string;
  deferred: string;
  retry: string;
  active: string;
  history: string[];
}

/** pg-boss 10's own schema, holding one job in each state core can leave behind at a deploy. */
async function seedV10(schema: string, more?: (v10: PgBossV10) => Promise<void>): Promise<Seeded> {
  const v10 = new PgBossV10({
    connectionString: harness.url,
    schema,
    supervise: false,
    schedule: false,
  });
  v10.on('error', () => {});
  await v10.start();
  await v10.createQueue('carry-plain');
  await v10.createQueue('carry-dead');
  await v10.createQueue('carry-retry', {
    name: 'carry-retry',
    retryLimit: 3,
    retryDelay: 2,
    deadLetter: 'carry-dead',
  });
  await v10.createQueue('carry-short', { name: 'carry-short', policy: 'short' });
  await v10.createQueue('carry-history');

  const queued = (await v10.send('carry-plain', { n: 'queued' })) as string;
  const deferred = (await v10.send(
    'carry-plain',
    { n: 'deferred' },
    { startAfter: 600 },
  )) as string;
  const retry = (await v10.send('carry-retry', { n: 'retry' })) as string;
  const [first] = await v10.fetch('carry-retry');
  await v10.fail('carry-retry', first?.id as string, { reason: 'first attempt' });
  const active = (await v10.send('carry-short', { n: 'active' }, { singletonKey: 'k1' })) as string;
  await v10.fetch('carry-short');
  const history: string[] = [];
  for (const n of ['done', 'failed', 'cancelled']) {
    history.push((await v10.send('carry-history', { n }, { retryLimit: 0 })) as string);
  }
  await v10.fetch('carry-history', { batchSize: 3 });
  await v10.complete('carry-history', history[0] as string);
  await v10.fail('carry-history', history[1] as string);
  await v10.cancel('carry-history', history[2] as string);
  await v10.schedule('carry-plain', '0 3 * * *');
  await more?.(v10);
  await v10.stop({ graceful: false, close: true, wait: true });
  return { queued, deferred, retry, active, history };
}

async function v12Ids(schema: string, ids: string[]): Promise<string[]> {
  const found = await rows<{ id: string }>(
    `SELECT id FROM ${schema}.job WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return found.map((row) => row.id).sort();
}

describe('core booting pg-boss 12 against a pg-boss 10 schema', () => {
  it('sets the schema aside, installs pg-boss 12 beside it and carries each live job once, by id', async () => {
    const schema = freshSchema();
    const seeded = await seedV10(schema);
    const queue = v12(schema);

    const carry = await bootBoss(queue, harness.url, bossSchemas(schema));

    expect(carry).toEqual({
      carried: { created: 2, retry: 1, active: 1 },
      queues: ['carry-plain', 'carry-dead', 'carry-retry', 'carry-short'],
      pastRetention: 0,
      history: 3,
      schedulesLeft: 1,
    });
    expect(await rows(`SELECT version FROM ${schema}.version`)).toEqual([{ version: 46 }]);
    expect(await rows(`SELECT version FROM ${schema}_v10.version`)).toEqual([{ version: 24 }]);

    const [plain] = await queue.fetch<{ n: string }>('carry-plain');
    expect(plain).toMatchObject({ id: seeded.queued, data: { n: 'queued' } });
    expect(await queue.fetch('carry-plain')).toEqual([]);
    const [shortJob] = await queue.fetch<{ n: string }>('carry-short', { includeMetadata: true });
    expect(shortJob).toMatchObject({
      id: seeded.active,
      data: { n: 'active' },
      retryLimit: 2,
      singletonKey: 'k1',
    });

    const deferredAt = async (at: string) =>
      (
        await rows<{ due: Date }>(`SELECT start_after AS due FROM ${at}.job WHERE id = $1`, [
          seeded.deferred,
        ])
      )[0]?.due;
    expect(await deferredAt(schema)).toEqual(await deferredAt(`${schema}_v10`));
    await sql.query(`UPDATE ${schema}.job SET start_after = now() WHERE id = $1`, [
      seeded.deferred,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const [later] = await queue.fetch<{ n: string }>('carry-plain');
    expect(later).toMatchObject({ id: seeded.deferred, data: { n: 'deferred' } });
    const [retried] = await queue.fetch<{ n: string }>('carry-retry', { includeMetadata: true });
    expect(retried).toMatchObject({ id: seeded.retry, data: { n: 'retry' }, retryLimit: 2 });
  }, 90_000);

  it('leaves completed, failed and cancelled jobs in the set-aside schema and none of them in pg-boss 12', async () => {
    const schema = freshSchema();
    const seeded = await seedV10(schema);
    await bootBoss(v12(schema), harness.url, bossSchemas(schema));

    expect(await v12Ids(schema, seeded.history)).toEqual([]);
    const kept = await rows<{ state: string }>(
      `SELECT state::text AS state FROM ${schema}_v10.job WHERE id = ANY($1::uuid[]) ORDER BY state`,
      [seeded.history],
    );
    expect(kept.map((row) => row.state)).toEqual(['cancelled', 'completed', 'failed']);
  }, 60_000);

  it('carries nothing on the next boot, and holds each carried job once', async () => {
    const schema = freshSchema();
    const seeded = await seedV10(schema);
    const live = [seeded.queued, seeded.deferred, seeded.retry, seeded.active];
    await bootBoss(v12(schema), harness.url, bossSchemas(schema));

    expect(await bootBoss(v12(schema), harness.url, bossSchemas(schema))).toBeNull();
    expect(await v12Ids(schema, live)).toEqual([...live].sort());
    expect(
      await rows(`SELECT count(*)::int AS n FROM ${schema}.job WHERE id = ANY($1::uuid[])`, [live]),
    ).toEqual([{ n: 4 }]);
  }, 60_000);

  it('leaves no carried job behind a carry that fails at its marker, and carries all of them on the next boot', async () => {
    const schema = freshSchema();
    const seeded = await seedV10(schema);
    const live = [seeded.queued, seeded.deferred, seeded.retry, seeded.active];
    // A domain of the marker's name: no relation, so the carry still runs, but CREATE TABLE needs the
    // name for the table's row type, so the marker fails after every insert has run.
    await sql.query(`CREATE DOMAIN ${schema}.carried_to_v12 AS int`);

    await expect(bootBoss(v12(schema), harness.url, bossSchemas(schema))).rejects.toThrow(
      /carried_to_v12/,
    );
    expect(await v12Ids(schema, live)).toEqual([]);

    await sql.query(`DROP DOMAIN ${schema}_v10.carried_to_v12`);
    const carry = await bootBoss(v12(schema), harness.url, bossSchemas(schema));
    expect(carry?.carried).toEqual({ created: 2, retry: 1, active: 1 });
    expect(await v12Ids(schema, live)).toEqual([...live].sort());
  }, 90_000);

  it('carries on the boot after one that stopped between the set-aside and the carry', async () => {
    const schema = freshSchema();
    const seeded = await seedV10(schema);
    const { setAsideV10Schema } = await import('../../src/queue/v10-carry.js');
    await setAsideV10Schema(harness.url, bossSchemas(schema));
    const interrupted = v12(schema);
    await interrupted.start();
    await interrupted.stop({ graceful: false });

    const carry = await bootBoss(v12(schema), harness.url, bossSchemas(schema));
    expect(carry?.carried).toEqual({ created: 2, retry: 1, active: 1 });
    expect(await v12Ids(schema, [seeded.queued])).toEqual([seeded.queued]);
  }, 60_000);

  it('installs pg-boss 12 on a database with no pg-boss schema and sets nothing aside', async () => {
    const schema = freshSchema();
    expect(await bootBoss(v12(schema), harness.url, bossSchemas(schema))).toBeNull();
    expect(await rows(`SELECT version FROM ${schema}.version`)).toEqual([{ version: 46 }]);
    expect(await rows(`SELECT to_regnamespace($1) AS ns`, [`${schema}_v10`])).toEqual([
      { ns: null },
    ]);
  }, 60_000);
});

describe('core refusing to boot pg-boss 12 over a pg-boss schema it cannot carry', () => {
  it('names the version of a schema older than pg-boss 10', async () => {
    const schema = freshSchema();
    await sql.query(`CREATE SCHEMA ${schema}`);
    await sql.query(`CREATE TABLE ${schema}.version (version int PRIMARY KEY)`);
    await sql.query(`INSERT INTO ${schema}.version VALUES (20)`);

    const boot = bootBoss(v12(schema), harness.url, bossSchemas(schema));
    await expect(boot).rejects.toThrow(BossSchemaRefusal);
    await expect(boot).rejects.toThrow(/is at version 20/);
  }, 60_000);

  it('names how many pub/sub subscriptions a pg-boss 10 schema holds, and renames nothing', async () => {
    const schema = freshSchema();
    await seedV10(schema, (v10) => v10.subscribe('carry-event', 'carry-plain'));

    await expect(bootBoss(v12(schema), harness.url, bossSchemas(schema))).rejects.toThrow(
      /holds 1 pub\/sub subscription/,
    );
    expect(await rows(`SELECT version FROM ${schema}.version`)).toEqual([{ version: 24 }]);
  }, 60_000);

  it('names how many pg-boss sessions are still connected, and boots once they are gone', async () => {
    const schema = freshSchema();
    await seedV10(schema);
    const stillRunning = new pg.Client({
      connectionString: harness.url,
      application_name: 'pgboss',
    });
    await stillRunning.connect();

    try {
      await expect(bootBoss(v12(schema), harness.url, bossSchemas(schema))).rejects.toThrow(
        /1 pg-boss session\(s\) are connected/,
      );
      expect(await rows(`SELECT version FROM ${schema}.version`)).toEqual([{ version: 24 }]);
    } finally {
      await stillRunning.end();
    }
    const carry = await bootBoss(v12(schema), harness.url, bossSchemas(schema));
    expect(carry?.carried).toEqual({ created: 2, retry: 1, active: 1 });
  }, 60_000);
});
