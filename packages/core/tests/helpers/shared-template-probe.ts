import type { Sql } from 'postgres';

/** The `pg_database` row and completeness marker of `name`, or undefined when it is not there. */
export async function templateRow(
  admin: Sql,
  name: string,
): Promise<{ oid: number; marker: string | null } | undefined> {
  const rows = await admin<{ oid: number; marker: string | null }[]>`
    SELECT oid::int AS oid, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE datname = ${name}`;
  return rows[0];
}

/** Backend pids holding a shared use lock on `name`, which is what a reaper reads as in use. */
export async function useLockHolders(admin: Sql, name: string): Promise<number[]> {
  const rows = await admin<{ pid: number }[]>`
    SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND mode = 'ShareLock' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`use:${name}`}, 0)`;
  return rows.map((r) => r.pid);
}
