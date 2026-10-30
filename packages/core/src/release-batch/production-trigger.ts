import { logger } from '../lib/logger.js';
import { deploysOnLandOf, readProjectDocument } from '../project-config/index.js';

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
