import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { dispatchLivenessMs } from './dispatch-liveness.js';

export async function findAvailableDeviceForProject(
  projectId: string,
  opts: { excludeDeviceIds?: string[] } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const exclude = (opts.excludeDeviceIds ?? []).filter((id): id is string => !!id);
  // Build a parenthesised parameter list and use `NOT IN (...)`. Interpolating a
  // JS array directly (`<> ALL(${exclude}::uuid[])`) expands as a record tuple
  // ($1,$2,…) → malformed array literal at query time. Same idiom as
  // mcp/tools/forge-metrics.ts.
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
    ORDER BY
      (CASE WHEN (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
                 AND r.limit_reason IS DISTINCT FROM 'auth'
            THEN 0 ELSE 1 END) ASC,
      r.last_seen_at DESC
    LIMIT 1
  `);
  if (rows[0]) return rows[0].device_id;

  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project?.defaultDeviceId || exclude.includes(project.defaultDeviceId)) return null;

  const [defaultDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.id, project.defaultDeviceId),
        eq(devices.status, 'online'),
        isNull(devices.disabledAt),
      ),
    )
    .limit(1);

  return defaultDevice?.id ?? null;
}

export async function findChatCapableDeviceForProject(
  projectId: string,
  deviceId: string,
  opts: { allowLimited?: boolean } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
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
    LIMIT 1
  `);
  return rows[0]?.device_id ?? null;
}

export function resolveRepoPath(
  override: string | null | undefined,
  projectRepoPath: string | null,
): string | null {
  const v = (override ?? projectRepoPath ?? '').trim();
  return v.length === 0 ? null : v;
}

export async function resolveRunnerRepoPath(
  projectId: string,
  deviceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: runners.repoPath })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  const v = (row?.repoPath ?? '').trim();
  return v.length === 0 ? null : v;
}

/**
 * Single cwd resolver for a chat/schedule turn dispatched to `deviceId` (or
 * `null` for the desktop/local path). Combines the runner binding lookup with
 * the project-default fallback so callers never hand-roll the chain.
 */
export async function resolveSessionRepoPathForDevice(
  projectId: string,
  deviceId: string | null,
  projectRepoPath: string | null,
): Promise<string | null> {
  const bindingRepo = deviceId ? await resolveRunnerRepoPath(projectId, deviceId) : null;
  return resolveRepoPath(null, bindingRepo ?? projectRepoPath ?? null);
}
