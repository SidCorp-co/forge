import { logger } from '../observability/logger.js';
import { productionOf } from '../project-config/release-path.js';
import { readProjectDocument } from '../project-config/service.js';

/** Whether the release sweep alone cuts releases here: production deploys `on-land`. */
// cm:edge naming -> packages/core/src/project-config/schema.ts:DEPLOYMENT_TRIGGERS
export async function productionDeploysOnLand(projectId: string): Promise<boolean> {
  try {
    const held = await readProjectDocument(projectId);
    const deployment = held ? productionOf(held.document)?.declaration.deployment : undefined;
    return !!deployment && 'trigger' in deployment && deployment.trigger === 'on-land';
  } catch (err) {
    logger.warn(
      { err, projectId },
      'release: failed to read the production deploy trigger — keeping prod gate',
    );
    return false;
  }
}
