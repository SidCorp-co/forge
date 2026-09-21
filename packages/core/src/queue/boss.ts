import PgBoss from 'pg-boss';
import { env } from '../config/env.js';

let instance: PgBoss | null = null;

function getBoss(): PgBoss {
  if (!instance) {
    instance = new PgBoss(env.DATABASE_URL);
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

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await boss.start();
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
