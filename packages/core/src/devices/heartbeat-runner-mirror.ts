import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface HeartbeatRunnerTransition {
  id: string;
  project_id: string;
  old_status: string;
}

export async function mirrorHeartbeatToRunners(
  deviceId: string,
): Promise<HeartbeatRunnerTransition[]> {
  const lapsed = sql`rate_limited_until IS NOT NULL AND rate_limited_until <= now()`;
  const rows = (await db.execute(sql`
      WITH prev AS (
        SELECT id, project_id, status AS old_status
        FROM runners
        WHERE device_id = ${deviceId}
      ),
      upd AS (
        UPDATE runners
        SET last_seen_at = now(), updated_at = now(),
            -- an operator's withdrawal MUST survive a beat: this column was set
            -- unconditionally, so "forge_runners retire" was undone within one
            -- heartbeat (2026-08-14: retired 08:19:29, online again 08:19:59).
            -- "disabled" was spared then and "draining" was not, so drain had the
            -- same 30-second life until the pool learned to read either.
            status = CASE WHEN status IN ('disabled', 'draining') THEN status ELSE 'online' END,
            limit_reason = CASE WHEN ${lapsed} THEN NULL ELSE limit_reason END,
            rate_limited_until = CASE WHEN ${lapsed} THEN NULL ELSE rate_limited_until END,
            limit_detail = CASE WHEN ${lapsed} THEN NULL ELSE limit_detail END,
            -- stampRunnerLimit mirrors limit_detail into last_error and nothing
            -- expired that copy: boxes sat "online" for hours still quoting a
            -- spend cap whose window had closed. Only the mirror is dropped --
            -- the equality check leaves a preflight/dispatch error written after
            -- the stamp intact, since that is a different string.
            last_error = CASE
              WHEN ${lapsed} AND last_error IS NOT DISTINCT FROM limit_detail
              THEN NULL ELSE last_error END
        WHERE device_id = ${deviceId}
        RETURNING id
      )
      SELECT id, project_id, old_status
      FROM prev
      WHERE old_status NOT IN ('online', 'disabled')
    `)) as unknown as HeartbeatRunnerTransition[] | undefined;
  return rows ?? [];
}
