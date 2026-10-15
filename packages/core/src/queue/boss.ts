import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import {
  type BossSchemas,
  bossSchemas,
  type Carry,
  carryV10Jobs,
  setAsideV10Schema,
} from './v10-carry.js';

let instance: PgBoss | null = null;

function getBoss(): PgBoss {
  if (!instance) {
    instance = new PgBoss(env.DATABASE_URL);
    // An `error` event with no listener throws out of the emitter and takes the process with it.
    instance.on('error', (err) => logger.error({ err }, 'pg-boss: error'));
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

/** Starts `queue` on `connectionString`, carrying a pg-boss 10 schema's live jobs into it first. */
export async function bootBoss(
  queue: PgBoss,
  connectionString: string,
  schemas: BossSchemas = bossSchemas(),
): Promise<Carry | null> {
  const setAside = await setAsideV10Schema(connectionString, schemas);
  if (setAside.action === 'set-aside') {
    logger.warn({ schema: schemas.schema, to: schemas.setAside }, 'pg-boss: v10 schema set aside');
  }
  await queue.start();
  const carry = await carryV10Jobs(queue, connectionString, schemas);
  if (carry) logger.warn({ ...carry, from: schemas.setAside }, 'pg-boss: v10 jobs carried');
  return carry;
}

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await bootBoss(getBoss(), env.DATABASE_URL);
  started = true;
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
