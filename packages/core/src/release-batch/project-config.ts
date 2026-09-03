// The project read the release path needs, in one place so the service and its
// read-only twin do not each grow a copy.

// cm:guard the branches come from the `projects.base_branch` / `production_branch` COLUMNS, never from `agentConfig`. This read went through `agentConfig.branchConfig` until 2026-09-03; that key exists on 0 of 38 projects, so every release since has believed base === production === 'main' and `productionMergePlanned` was false for sid-desk (staging->master), epodsystem-core (dev->master) and every other promoting project — the prompt never asked for the merge the release existed to make.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

export async function loadProjectBranchConfig(
  projectId: string,
): Promise<{ baseBranch: string; productionBranch: string } | null> {
  const [row] = await db
    .select({ baseBranch: projects.baseBranch, productionBranch: projects.productionBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return {
    baseBranch: row.baseBranch ?? 'main',
    productionBranch: row.productionBranch ?? 'main',
  };
}
