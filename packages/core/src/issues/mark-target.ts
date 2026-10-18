/**
 * The branch a mark's `target` token means on its issue (ISS-1421 round 8). MCP's `mark_merged`
 * takes `base`, `prod` or `feature` rather than a branch, and the comment a mark writes names a
 * branch: the project's base branch, its live branch, or the branch recorded for the issue.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { collectWorkEvidence } from '../pipeline/work-evidence.js';
import { chainLiveBranch } from '../projects/release-chain.js';

export type MarkTargetToken = 'feature' | 'base' | 'prod';

/** Where nothing names the branch, the words say which one is meant rather than the token. */
const UNNAMED: Record<MarkTargetToken, string> = {
  base: 'the base branch',
  prod: 'the live branch',
  feature: "the issue's branch",
};

export async function markTargetBranch(
  issue: { id: string; projectId: string },
  token: MarkTargetToken,
): Promise<string> {
  if (token === 'feature') {
    return (await collectWorkEvidence(issue.id)).branch ?? UNNAMED.feature;
  }
  const [row] = await db
    .select({ baseBranch: projects.baseBranch, releaseChain: projects.releaseChain })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  const branch =
    token === 'base' ? row?.baseBranch?.trim() : row ? chainLiveBranch(row.releaseChain) : null;
  return branch || UNNAMED[token];
}
