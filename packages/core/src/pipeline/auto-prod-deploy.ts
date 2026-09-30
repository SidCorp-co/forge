import { logger } from '../logger.js';
import { readProjectDocument } from '../project-config/service.js';

/**
 * Whether a release here is taken without a person confirming it, which makes `release-sweep.ts`
 * the only thing that cuts it: the project document's production environment deploys on land.
 * No document, no production environment, another trigger or a failed read keeps the gate on.
 */
// cm:edge naming -> packages/core/src/project-config/schema.ts:DEPLOYMENT_TRIGGERS — `on-land` is
// the trigger that leaves nobody an act; `on-request` and `provider` both wait on someone else.
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
