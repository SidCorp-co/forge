import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { dispatchLivenessMs } from './dispatch-liveness.js';

export async function findAvailableDeviceForProject(
  projectId: string,
  opts: {
    excludeDeviceIds?: string[];
    /** Only a box whose heartbeat declared this capability `true`. */
    requireCapability?: string;
  } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const capable = (deviceId: SQL) =>
    opts.requireCapability
      ? sql`AND EXISTS (SELECT 1 FROM devices c WHERE c.id = ${deviceId} AND c.capabilities ->> ${opts.requireCapability} = 'true')`
      : sql``;
  const exclude = (opts.excludeDeviceIds ?? []).filter((id): id is string => !!id);
  // Build a parenthesised parameter list and use `NOT IN (...)`. Interpolating a
  // JS array directly (`<> ALL(${exclude}::uuid[])`) expands as a record tuple
  // ($1,$2,…) → malformed array literal at query time.
  const excludeClause = exclude.length
    ? sql`AND r.device_id NOT IN (${sql.join(
        exclude.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.type       = 'claude-code'
      AND r.status     = 'online'
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
      ${excludeClause}
      ${capable(sql`r.device_id`)}
    ORDER BY
      (CASE WHEN (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
                 AND r.limit_reason IS DISTINCT FROM 'auth'
            THEN 0 ELSE 1 END) ASC,
      r.last_seen_at DESC
    LIMIT 1
  `);
  return rows[0]?.device_id ?? null;
}

export async function findChatCapableDeviceForProject(
  projectId: string,
  deviceId: string,
  opts: { allowLimited?: boolean; requireCapability?: string } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const capableClause = opts.requireCapability
    ? sql`AND EXISTS (SELECT 1 FROM devices c WHERE c.id = r.device_id AND c.capabilities ->> ${opts.requireCapability} = 'true')`
    : sql``;
  const healthClause = opts.allowLimited
    ? sql``
    : sql`AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
          AND r.limit_reason IS DISTINCT FROM 'auth'`;
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.device_id  = ${deviceId}
      AND r.type       = 'claude-code'
      AND r.status     = 'online'
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
      ${healthClause}
      ${capableClause}
    LIMIT 1
  `);
  return rows[0]?.device_id ?? null;
}

async function resolveRunnerRepoPath(projectId: string, deviceId: string): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: runners.repoPath })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  const v = (row?.repoPath ?? '').trim();
  return v.length === 0 ? null : v;
}

/**
 * The checkout a chat/schedule turn on `deviceId` runs in: that device's binding to the project,
 * and nothing else. `null` for the desktop/local path, and for a binding that names none.
 */
export async function resolveSessionRepoPathForDevice(
  projectId: string,
  deviceId: string | null,
): Promise<string | null> {
  return deviceId ? resolveRunnerRepoPath(projectId, deviceId) : null;
}
