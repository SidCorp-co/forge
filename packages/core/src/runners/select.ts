import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idList } from '../db/raw-sql.js';
import { rowsPerProject } from '../db/read-memo.js';
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
  // every project's asks before the quiet point are one read each way it is asked (ISS-1070 r6)
  const rows = await rowsPerProject(
    `onlineCapable:${required}:${opts?.includeLimited === true}:${opts?.includeBelowFloor === true}:${opts?.allowDeviceIds === undefined ? '' : JSON.stringify(opts.allowDeviceIds)}`,
    projectId,
    async (ids) => [
      ...(await db.execute<{ project_id: string; device_id: string }>(
        sql`
      SELECT DISTINCT project_id, device_id
      FROM runners
      WHERE project_id IN (${idList(ids)})
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
      )),
    ],
    (r) => r.project_id,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}
