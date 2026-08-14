// Runner half of the device heartbeat: mirrors last_seen_at/status onto every
// runner bound to the device, and expires health flags the runner has outlived.
//
// Extracted from the heartbeat route so the raw CTE is reachable from an
// integration test without a paired device + HTTP round-trip — the clearing
// rules are pure SQL, so a mocked-db unit test can only assert the string.
//
// Clearing rule, singular: a limit clears here ONLY once its own reset time has
// passed. That is the one fact a heartbeat can establish. Every other clear
// belongs to a mechanism that has real evidence — a successful job
// (`apply-runner-limit.ts`) or the operator's Clear-error button
// (`clear-fault-flags.ts`).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface HeartbeatRunnerTransition {
  id: string;
  project_id: string;
  old_status: string;
}

// cm:edge lockstep -> packages/core/src/runners/apply-runner-limit.ts — the two halves of "a runner never reports a fault it has outlived": success clears there, expiry clears here
export async function mirrorHeartbeatToRunners(
  deviceId: string,
): Promise<HeartbeatRunnerTransition[]> {
  // cm:why ISS-381 2.3 — `prev` snapshots status BEFORE the UPDATE so a steady-state tick updates last_seen_at for every binding yet emits no runner_events row; only offline→online is audited
  // cm:guard the ONLY thing a heartbeat proves is that the runner daemon is alive — keep this predicate purely TIME-BASED. It once also matched `limit_reason='auth'`, which erased the auth stamp ~30s after every failure, so no dispatch gate ever saw it: device dev1-ai013 burned 421 jobs in 5.5h on an expired Claude OAuth session (measured forge-beta 2026-08-14, one failure every ~47s = the heartbeat period). A live daemon and a valid OAuth session are different facts.
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
            -- cm:guard "disabled" is an operator decision and MUST survive a beat — this
            -- column was set unconditionally, so "forge_runners retire" was undone within
            -- one heartbeat (measured 2026-08-14: retired 08:19:29, online again 08:19:59),
            -- which left no MCP-reachable way to remove a bad runner at all.
            status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'online' END,
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
