import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projectDevices, projects } from '../db/schema.js';

/**
 * Pick a device for a new agent session for `projectId`.
 *
 * Resolution order:
 *  1. Online device in the project's device pool (`project_devices`),
 *     preferring the most-recently-seen one. The dispatcher picks freshest
 *     so that a revived runner gets traffic immediately rather than starving
 *     behind a long-quiet sibling.
 *  2. The project's `defaultDeviceId` if it points to an online device.
 *  3. `null` — caller must surface "no device available" to the user.
 *
 * Devices in `revoked` status never qualify; they would fail authentication
 * on the next heartbeat anyway.
 */
export async function findAvailableDeviceForProject(
  projectId: string,
): Promise<string | null> {
  const poolRows = await db
    .select({
      id: devices.id,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(projectDevices)
    .innerJoin(devices, eq(devices.id, projectDevices.deviceId))
    .where(and(eq(projectDevices.projectId, projectId), eq(devices.status, 'online')))
    .orderBy(desc(devices.lastSeenAt));
  if (poolRows[0]) return poolRows[0].id;

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
