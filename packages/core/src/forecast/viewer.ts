import { loadProjectAccess } from '../lib/authz.js';
import { holds, requireHeld } from '../permissions/index.js';
import type { ForecastViewer } from './release.js';

/** The reader, with the grants that make a person's act it names theirs; refused without project.read. */
export async function forecastViewerOf(projectId: string, userId: string): Promise<ForecastViewer> {
  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');
  return {
    userId,
    isAdmin: holds(access, 'project.admin'),
    mayApprove: holds(access, 'releases.approve'),
    canWrite: holds(access, 'project.write'),
  };
}
