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

// cm:why two hours rather than minutes: the cutoff's only job is to keep the reaper off a LIVE run's databases, and being slow to clear a leftover costs disk while being early costs another run its suite — the exact failure this file removes. A leftover that survives two hours is reaped by the next run after that.
const ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

// cm:guard the birth time is carried IN THE NAME and nowhere else. Postgres records no creation timestamp for a database — `pg_database` has no such column and reading the file's mtime needs `pg_stat_file`, which is superuser-only and refused on the shared server this suite is expected to run against. A reaper that cannot date a database can only reap by prefix, and reaping by prefix is dropping whatever another run is using.
const STAMPED = /_([0-9a-z]+)_[0-9a-f]{8}$/;

// cm:guard a parsed number is not yet a timestamp, and this floor is what makes it one. The PREVIOUS name shape `test_w29_9ed50deb` also matches the pattern above, with `w29` read as base 36 — 41553, an instant in 1970, which dated a database from a concurrent run on older code as decades abandoned and made this reaper do the very thing ISS-937 is about. Two such databases were dropped that way on the shared server before the floor existed. Any name whose stamp predates this repo is one this suite did not mint.
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
// cm:guard plain DROP, never `WITH (FORCE)`, and that is the second defence rather than a detail. FORCE severs live connections, so a clock skew or a suite that genuinely ran for hours would let this reaper do the very thing ISS-937 was filed about — delete the database another run is using — while the age cutoff above is the first defence. Postgres refuses a plain DROP on a database with sessions attached, so the two together mean a live run is safe even if the cutoff is wrong.
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
