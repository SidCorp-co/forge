/**
 * An environment that deploys `on-land` is deployed when work lands on the branch it deploys from
 * (REQ-71 BC-8). Nothing read that trigger off production: a write checked it against the binding's
 * adapter and every merge after deployed nothing (catalog-api `dev`, binding 2538bebc, merges
 * 105eb7d6 and 307f35d8 through Forge's merge door on 2026-10-27, both deployed by hand). A push the
 * host reports onto that branch is the landing, whichever door merged it, so the push deploys it.
 *
 * Production is the release's: its `on-land` is the release sweep's cut (`release-sweep.ts`), and a
 * binding reaching production's box parks for a person (`dispatchCoolifyDeployDirect`).
 */

import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { environmentsOf, readProjectDocument } from '../project-config/index.js';
import { dispatchCoolifyDeployDirect } from './release-coolify.js';

/** Where a landing on `branch` at `commit` deploys: each binding dispatched, or why one was not. */
export interface LandingDeploy {
  environment: string;
  binding: string;
  dispatched: boolean;
  why: string | null;
}

/** Deploy every non-production environment that deploys `on-land` from `branch`, once per commit. */
export async function deployLanding(p: {
  projectId: string;
  branch: string | null;
  commit: string | null;
}): Promise<LandingDeploy[]> {
  if (!p.branch || !p.commit) return [];
  const held = await readProjectDocument(p.projectId);
  if (!held) return [];
  const source = held.document.source;
  const landing = source.type === 'git' ? source.git.defaultBranch : null;
  const out: LandingDeploy[] = [];
  for (const { name, declaration } of environmentsOf(held.document)) {
    const d = declaration.deployment;
    if (declaration.tier === 'production' || !('binding' in d) || d.trigger !== 'on-land') continue;
    // an environment naming no branch deploys from where work lands
    if ((declaration.deploysFrom ?? landing) !== p.branch) continue;
    const outcome = await dispatchCoolifyDeployDirect({
      projectId: p.projectId,
      integrationId: d.binding,
      requestId: `on-land:${d.binding}:${p.commit}`,
    });
    const why = outcome.dispatched
      ? null
      : outcome.pendingHumanConfirm
        ? `binding ${d.binding} reaches production's box, which deploys only through a release or a person's confirm`
        : `binding ${d.binding} is no active Coolify binding of this project, and no other provider deploys on a landing`;
    if (why) {
      logger.warn(
        { projectId: p.projectId, environment: name, branch: p.branch, commit: p.commit },
        `on-land deploy of \`${name}\` not dispatched: ${why}`,
      );
    }
    out.push({ environment: name, binding: d.binding, dispatched: outcome.dispatched, why });
  }
  return out;
}

export function registerLandingDeploy(): void {
  consume('source.pushed', {
    name: 'on-land-deploy',
    handle: async (p) => {
      await deployLanding(p);
    },
  });
}
