import { logger } from '../lib/logger.js';
import {
  deploysOnLandOf,
  type ProjectDocument,
  productionOf,
  readProjectDocument,
} from '../project-config/index.js';
import type { ReleaseChannel } from './plan.js';

/** Whether the release sweep alone cuts releases here: production deploys `on-land`. */
// naming -> packages/core/src/project-config/schema.ts:DEPLOYMENT_TRIGGERS
export async function productionDeploysOnLand(projectId: string): Promise<boolean> {
  try {
    return deploysOnLandOf((await readProjectDocument(projectId))?.document);
  } catch (err) {
    logger.warn(
      { err, projectId },
      'release: failed to read the production deploy trigger — keeping prod gate',
    );
    return false;
  }
}

/**
 * Whether a release's production deploy will park for a person's confirm: production is bound to a
 * Coolify binding the release run deploys, on request rather than on land or by the provider itself
 * (`release-coolify.ts:tryDispatchCoolifyRelease`), so the approval can say so (ISS-1096).
 */
export function productionAsksConfirm(
  channels: readonly Pick<ReleaseChannel, 'provider'>[],
  document: ProjectDocument | undefined,
): boolean {
  if (channels[0]?.provider !== 'coolify' || !document) return false;
  const deployment = productionOf(document)?.declaration.deployment;
  return !!deployment && 'trigger' in deployment && deployment.trigger === 'on-request';
}
