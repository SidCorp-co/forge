/**
 * The one rule for a Coolify act that changes what is running: `deploys.run` on the project. The REST
 * routes and the MCP tool both ask it here, so neither door decides it alone.
 */

import { type PermissionActor, projectResource, requireCan } from '../permissions/index.js';

export async function requireCoolifyRun(
  actor: PermissionActor,
  projectId: string,
  act: 'deploy' | 'cancel' | 'rollback',
): Promise<void> {
  await requireCan(actor, 'deploys.run', projectResource(projectId), `Coolify ${act}`);
}
