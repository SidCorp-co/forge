import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * Names for the databases an integration run creates, and the reaper that
 * clears the ones a crashed run left behind.
 *
 * One fixed name for a mutable resource shared by every run on the box is the
 * defect this file exists to remove: the template used to be the constant
 * `forge_test_tpl`, dropped and recreated at the start of every run, so the
 * second run to enter global setup deleted the one the first was still cloning
 * from. The loser reported `template database "forge_test_tpl" does not exist`
 * — a sentence naming a Postgres object, on files the change never touched,
 * with no field in which to say "another run owns this" (ISS-937).
 */

export const TEMPLATE_PREFIX = 'forge_test_tpl_';
export const WORKER_PREFIX = 'test_w';

const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

const STAMPED = /_([0-9a-z]+)_[0-9a-f]{8}$/;

const EPOCH_FLOOR = Date.UTC(2020, 0, 1);

function stamp(): string {
  return `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** A template database name unique to this run. */
export function templateDbName(): string {
  return `${TEMPLATE_PREFIX}${stamp()}`;
}

/** A worker database name unique to this run and this vitest worker. */
export function workerDbName(workerId: string): string {
  return `${WORKER_PREFIX}${workerId}_${stamp()}`;
}

/** When the run that created `datname` started, or null for a name this suite did not mint. */
export function bornAt(datname: string): number | null {
  const m = STAMPED.exec(datname);
  if (!m?.[1]) return null;
  const ms = Number.parseInt(m[1], 36);
  return Number.isFinite(ms) && ms >= EPOCH_FLOOR ? ms : null;
}

/** True when `datname` is old enough that no live run can still own it. */
export function isAbandoned(datname: string, now: number): boolean {
  const born = bornAt(datname);
  return born !== null && now - born > ABANDONED_AFTER_MS;
}

/**
 * Drop the scratch databases left by runs that crashed before their teardown.
 * Returns the names actually dropped.
 */
export async function reapAbandoned(admin: Sql, now: number = Date.now()): Promise<string[]> {
  const rows = await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database
    WHERE datname LIKE ${`${TEMPLATE_PREFIX}%`} OR datname LIKE ${`${WORKER_PREFIX}%`}
  `;
  const dropped: string[] = [];
  for (const { datname } of rows) {
    if (!isAbandoned(datname, now)) continue;
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}"`);
      dropped.push(datname);
    } catch {}
  }
  return dropped;
}
