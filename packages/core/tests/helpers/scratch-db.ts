import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';

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
