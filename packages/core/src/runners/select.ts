import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { CLAIM_CAPABLE_DEVICE } from './device-cap.js';
import {
  deviceNotDisabled,
  livenessSeconds,
  runnerFresh,
  runnerUnlimited,
  runnerWorkspaceReady,
} from './liveness-sql.js';
import type { RequiredCapabilities } from './types.js';

/**
 * A caller's device allow-list as a candidate filter. `null`/empty → no
 * fragment, so the fleet stays fully eligible.
 *
 * `column` lets a caller that aliases `runners` pass `sql`r.device_id``.
 */
function poolClause(deviceIds: string[] | null | undefined, column = sql`device_id`) {
  if (!deviceIds || deviceIds.length === 0) return sql``;
  return sql`AND ${column} IN (${sql.join(
    deviceIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

export async function onlineCapableDeviceIds(
  projectId: string,
  requiredCapabilities?: RequiredCapabilities,
  opts?: {
    includeLimited?: boolean;
    includeBelowFloor?: boolean;
    allowDeviceIds?: string[] | null;
  },
): Promise<string[]> {
  const required = JSON.stringify(requiredCapabilities ?? {});
  const floorClause = opts?.includeBelowFloor ? sql`` : CLAIM_CAPABLE_DEVICE;
  const limitClause = opts?.includeLimited ? sql`` : sql`AND ${runnerUnlimited('runners')}`;
  const rows = await db.execute<{ device_id: string }>(
    sql`
      SELECT DISTINCT device_id
      FROM runners
      WHERE project_id = ${projectId}
        AND device_id IS NOT NULL
        AND capabilities @> ${required}::jsonb
        AND ${runnerFresh('runners', livenessSeconds())}
        ${limitClause}
        AND ${runnerWorkspaceReady('runners')}
        AND ${deviceNotDisabled('runners')}
        ${floorClause}
        ${poolClause(opts?.allowDeviceIds)}
      ORDER BY device_id ASC
    `,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}
