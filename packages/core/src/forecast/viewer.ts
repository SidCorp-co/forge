import { loadProjectAccess } from '../lib/authz.js';
import { holds, requireHeld } from '../permissions/index.js';
import type { ForecastViewer } from './release.js';

/** The reader, with the grants that make a person's act it names theirs; refused without project.read. */
export async function forecastViewerOf(projectId: string, userId: string): Promise<ForecastViewer> {
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
  return viewerOf(access, userId);
}

/**
 * The reader, for a route that declares project.read and was checked by it before its handler; this
 * reads the grants the forecast names a person's act by, and checks nothing.
 */
export async function forecastViewerFor(
  projectId: string,
  userId: string,
): Promise<ForecastViewer> {
  return viewerOf(await loadProjectAccess(projectId, userId), userId);
}

function viewerOf(
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
): ForecastViewer {
  return {
    userId,
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
    canWrite: holds(access, 'project.write'),
  };
}
