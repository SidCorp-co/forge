import { RUNNER_MACHINE } from '@forge/contracts/runner-machine';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { transition } from '../lifecycle/index.js';

export interface HeartbeatRunnerTransition {
  id: string;
  project_id: string;
  old_status: string;
}

/**
 * A device's beat stamps every runner it carries and brings an offline one online. An operator's
 * withdrawal survives a beat: `disabled` and `draining` are left where they are (2026-08-14:
 * "forge_runners retire" was undone within one heartbeat while this wrote the column outright).
 */
export async function mirrorHeartbeatToRunners(
  deviceId: string,
): Promise<HeartbeatRunnerTransition[]> {
  const lapsed = sql`rate_limited_until IS NOT NULL AND rate_limited_until <= now()`;
  await db.execute(sql`
    UPDATE runners
    SET last_seen_at = now(), updated_at = now(),
        limit_reason = CASE WHEN ${lapsed} THEN NULL ELSE limit_reason END,
        rate_limited_until = CASE WHEN ${lapsed} THEN NULL ELSE rate_limited_until END,
        limit_detail = CASE WHEN ${lapsed} THEN NULL ELSE limit_detail END,
        -- stampRunnerLimit mirrors limit_detail into last_error and nothing expired that copy;
        -- only the mirror is dropped, so a preflight or dispatch error written after the stamp stays.
        last_error = CASE
          WHEN ${lapsed} AND last_error IS NOT DISTINCT FROM limit_detail
          THEN NULL ELSE last_error END
    WHERE device_id = ${deviceId}
  `);
  const { rows } = await transition(db, RUNNER_MACHINE, {
    to: 'online',
    from: 'offline',
    where: eq(runners.deviceId, deviceId),
    actor: { type: 'runner', id: deviceId },
    source: 'device-heartbeat',
    returning: ['id', 'projectId'],
  });
  return rows.map((r) => ({ id: r.id, project_id: r.projectId, old_status: 'offline' }));
}
