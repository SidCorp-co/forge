import { logger } from '../logger.js';
import { readProjectDocument } from '../project-config/service.js';

/** Whether the release sweep alone cuts releases here: production deploys `on-land`. */
// cm:edge naming -> packages/core/src/project-config/schema.ts:DEPLOYMENT_TRIGGERS
export async function projectAutoProdDeploy(projectId: string): Promise<boolean> {
  try {
    const held = await readProjectDocument(projectId);
    if (!held) return false;
    return Object.values(held.document.environments).some(
      (env) =>
        env.tier === 'production' &&
        'trigger' in env.deployment &&
        env.deployment.trigger === 'on-land',
    );
  } catch (err) {
    logger.warn(
      { err, projectId },
      'release: failed to read the production deploy trigger — keeping prod gate',
    );
    return false;
  }
}
