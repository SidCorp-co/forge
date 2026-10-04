import { type CommandResponse, PgBoss, type Queue } from 'pg-boss';
import { env } from '../config/env.js';
import { carryOverV10Jobs } from './v10-carry-over.js';

/**
 * pg-boss 12 cannot migrate the version-24 schema 10.4.2 wrote in `pgboss`, so it installs here
 * and `carryOverV10Jobs` copies what was still waiting. `pgboss` is left as 10.4.2 wrote it; ADR
 * 0008 names the condition for dropping it.
 */
export const BOSS_SCHEMA = 'pgboss_v12';

/** A `retentionSeconds` for a queue whose waiting jobs are a record nothing may expire. */
export const KEEP_WAITING_JOBS_SECONDS = 2_147_483_647;

let instance: PgBoss | null = null;

function getBoss(): PgBoss {
  if (!instance) {
    instance = new PgBoss({ connectionString: env.DATABASE_URL, schema: BOSS_SCHEMA });
  }
  return instance;
}

/**
 * Transparent lazy proxy preserving the original `boss.<method>()` API. PgBoss
 * is only constructed on the first property access, never at import.
 */
export const boss: PgBoss = new Proxy({} as PgBoss, {
  get(_target, prop, receiver) {
    const b = getBoss();
    const value = Reflect.get(b as object, prop, receiver);
    return typeof value === 'function' ? value.bind(b) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(getBoss() as object, prop, value);
  },
  has(_target, prop) {
    return prop in (getBoss() as object);
  },
});

/**
 * Creates the queue, or brings an existing one to `options`: pg-boss's `createQueue` ignores the
 * options of a queue that already exists. A policy cannot be changed in place, so a queue that
 * exists under another one is refused by name.
 */
export async function declareQueue(name: string, options: Omit<Queue, 'name'> = {}): Promise<void> {
  await boss.createQueue(name, options);
  const existing = await boss.getQueue(name);
  const policy = options.policy ?? 'standard';
  if (existing && existing.policy !== policy) {
    throw new Error(
      `queue \`${name}\` exists with policy \`${existing.policy}\`, and this build declares \`${policy}\`; a policy is not changed in place`,
    );
  }
  const { policy: _policy, partition: _partition, ...updatable } = options;
  if (Object.keys(updatable).length > 0) await boss.updateQueue(name, updatable);
}

/**
 * How many jobs a pg-boss command changed. pg-boss 12.36 returns `{ jobs, requested, affected }` and
 * declares `CommandResponse` empty, so the count is read here once, and its absence is refused.
 */
export function affectedBy(response: CommandResponse): number {
  const affected = (response as { affected?: unknown }).affected;
  if (typeof affected !== 'number') {
    throw new Error(
      'pg-boss returned no affected count; this build reads the 12.36 command response',
    );
  }
  return affected;
}

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await boss.start();
  started = true;
  await carryOverV10Jobs(boss);
}

export async function stopBoss(): Promise<void> {
  if (!started) return;
  await boss.stop({ graceful: true });
  started = false;
}

export function isBossStarted(): boolean {
  return started;
}

export type Boss = typeof boss;
