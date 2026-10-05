/**
 * The one rule for a Coolify act that changes what is running: `deploys.run` on the project. The REST
 * routes and the MCP tool both ask it here, so neither door decides it alone.
 */

import { CoolifyApiError, describeCoolifyForbidden } from '../integrations/deploy/index.js';
import { type PermissionActor, projectResource, requireCan } from '../permissions/index.js';

/** Coolify's own refusal, named the same way on both doors; null for anything that is not one. */
export function coolifyRefusal(err: unknown): string | null {
  if (!(err instanceof CoolifyApiError)) return null;
  return err.status === 403
    ? describeCoolifyForbidden(err)
    : `Coolify answered HTTP ${err.status} to ${err.route ?? 'the request Forge made'}`;
}

export async function requireCoolifyRun(
  actor: PermissionActor,
  projectId: string,
  act: 'deploy' | 'cancel' | 'rollback',
): Promise<void> {
  await requireCan(actor, 'deploys.run', projectResource(projectId), `Coolify ${act}`);
}

/** The keys a caller set, so an absent option stays absent rather than an explicit undefined. */
export function given<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
