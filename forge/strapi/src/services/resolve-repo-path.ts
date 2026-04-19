/**
 * Resolve repoPath for a device + project combination.
 *
 * Resolution order:
 *  1. Explicit repoPath (caller passed it directly)
 *  2. Device-specific path (device.projectPaths[projectSlug])
 *  3. Project default (project.repoPath) — pass via projectRepoPath to skip DB query
 *  4. Empty string (desktop will auto-create from projectsRoot)
 */

const DEVICE_UID = 'api::device.device' as any;
const PROJECT_UID = 'api::project.project' as any;

export async function resolveRepoPath(
  strapi: any,
  projectSlug: string,
  deviceId: string | null,
  explicitRepoPath?: string,
  projectRepoPath?: string,
): Promise<string> {
  if (explicitRepoPath) return explicitRepoPath;

  if (deviceId) {
    const devices = await strapi.documents(DEVICE_UID).findMany({
      filters: { deviceId: { $eq: deviceId } },
      fields: ['projectsRoot', 'projectPaths'],
      limit: 1,
    });
    const device = devices[0];

    // Prefer per-project path (set during init), then fall back to projectsRoot/slug
    const devicePath = device?.projectPaths?.[projectSlug];
    if (devicePath) return devicePath;

    if (device?.projectsRoot) {
      const sep = device.projectsRoot.includes('/') ? '/' : '\\';
      return `${device.projectsRoot.replace(/[\\/]+$/, '')}${sep}${projectSlug}`;
    }
  }

  // Use caller-provided project repoPath to avoid redundant query
  if (projectRepoPath !== undefined) return projectRepoPath || '';

  const projects = await strapi.documents(PROJECT_UID).findMany({
    filters: { slug: { $eq: projectSlug } },
    fields: ['repoPath'],
    limit: 1,
  });
  return projects[0]?.repoPath || '';
}
