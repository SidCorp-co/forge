import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects } from '../db/schema.js';
import { dispatchLivenessMs } from './dispatch-liveness.js';

/**
 * Pick a device for a new interactive agent session for `projectId`.
 *
 * Resolution order:
 *  1. The freshest online `claude-code` runner row for this project (mirrors
 *     `selectRunnerForJob` filters: status='online', host='device',
 *     last_seen_at within the dispatch-liveness window).
 *  2. The project's `defaultDeviceId` if it points to an online device.
 *  3. `null` — caller must surface "no device available" to the user.
 *
 * ISS-172 Slice A: the source of truth is the `runners` table, not the
 * deprecated `project_devices` pool. A device may be a runner for N projects
 * simultaneously; this query returns the device id for THIS project only.
 */
export async function findAvailableDeviceForProject(
  projectId: string,
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.type       = 'claude-code'
      AND r.host       = 'device'
      AND r.status     = 'online'
      AND r.device_id IS NOT NULL
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
    ORDER BY r.last_seen_at DESC
    LIMIT 1
  `);
  if (rows[0]) return rows[0].device_id;

  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project?.defaultDeviceId) return null;

  const [defaultDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, project.defaultDeviceId), eq(devices.status, 'online')))
    .limit(1);

  return defaultDevice?.id ?? null;
}

/**
 * Resolve the working repo path for a session.
 *
 * The web client may pass an explicit `repoPath` override; otherwise we fall
 * back to `projects.repoPath`. We do NOT fall back to a per-device override
 * — that's a Strapi-era concept (`device.projectPaths[slug]`) that does not
 * exist in core's device schema yet. Add it back if the desktop client needs
 * per-device path overrides.
 */
export function resolveRepoPath(
  override: string | null | undefined,
  projectRepoPath: string | null,
): string | null {
  const v = (override ?? projectRepoPath ?? '').trim();
  return v.length === 0 ? null : v;
}
