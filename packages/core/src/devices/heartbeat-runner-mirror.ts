// Runner half of the device heartbeat: mirrors last_seen_at/status onto every
// runner bound to the device, and expires health flags the runner has outlived.
//
// Extracted from the heartbeat route so the raw CTE is reachable from an
// integration test without a paired device + HTTP round-trip — the clearing
// rules are pure SQL, so a mocked-db unit test can only assert the string.
//
// Clearing rules: an `auth` limit carries no reset time, so it clears on the
// next live heartbeat (the operator presumably fixed the credentials; if not,
// the next job re-stamps it). A time-based limit clears only once its reset has
// passed — an active throttle must persist or the dispatcher stops skipping.

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
  const rows = (await db.execute(sql`
      WITH prev AS (
        SELECT id, project_id, status AS old_status
        FROM runners
        WHERE device_id = ${deviceId}
      ),
      upd AS (
        UPDATE runners
        SET last_seen_at = now(), status = 'online', updated_at = now(),
            limit_reason = CASE
              WHEN limit_reason = 'auth'
                OR (rate_limited_until IS NOT NULL AND rate_limited_until <= now())
              THEN NULL ELSE limit_reason END,
            rate_limited_until = CASE
              WHEN limit_reason = 'auth'
                OR (rate_limited_until IS NOT NULL AND rate_limited_until <= now())
              THEN NULL ELSE rate_limited_until END,
            limit_detail = CASE
              WHEN limit_reason = 'auth'
                OR (rate_limited_until IS NOT NULL AND rate_limited_until <= now())
              THEN NULL ELSE limit_detail END,
            -- stampRunnerLimit mirrors limit_detail into last_error and nothing
            -- expired that copy: boxes sat "online" for hours still quoting a
            -- spend cap whose window had closed. Only the mirror is dropped --
            -- the equality check leaves a preflight/dispatch error written after
            -- the stamp intact, since that is a different string.
            last_error = CASE
              WHEN (limit_reason = 'auth'
                     OR (rate_limited_until IS NOT NULL AND rate_limited_until <= now()))
                   AND last_error IS NOT DISTINCT FROM limit_detail
              THEN NULL ELSE last_error END
        WHERE device_id = ${deviceId}
        RETURNING id
      )
      SELECT id, project_id, old_status
      FROM prev
      WHERE old_status <> 'online'
    `)) as unknown as HeartbeatRunnerTransition[] | undefined;
  return rows ?? [];
}
