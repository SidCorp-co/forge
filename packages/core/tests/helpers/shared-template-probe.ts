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

/** Backend pids holding a shared use lock on `name` (what a reaper reads as in use), named `from` if given. */
export async function useLockHolders(admin: Sql, name: string, from?: string): Promise<number[]> {
  const rows = await admin<{ pid: number; app: string | null }[]>`
    SELECT l.pid, a.application_name AS app FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.mode = 'ShareLock' AND l.granted
      AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${`use:${name}`}, 0)`;
  return rows.filter((r) => from === undefined || r.app === from).map((r) => r.pid);
}
