import PgBoss from 'pg-boss';
import { env } from '../config/env.js';

let instance: PgBoss | null = null;

/**
 * Lazily construct the singleton PgBoss.
 *
 * `new PgBoss(connectionString)` validates the connection string in its
 * constructor and throws synchronously on a missing/invalid one. Constructing
 * it at module top-level (the old `export const boss = new PgBoss(...)`) meant
 * merely *importing* this file — which route/dispatcher modules pull in
 * transitively — required a real `DATABASE_URL`. Unit tests that `vi.mock`
 * `../config/env.js` without a `DATABASE_URL` then crashed at import with
 * `new PgBoss(undefined)`, taking the whole test file down (0 tests collected)
 * and failing the pre-push full-suite run on any machine without a DB env
 * (ISS-375 / ubuntu6). Deferring construction to first real use keeps importing
 * this module side-effect free.
 */
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
