/**
 * The release model and its two dependent columns, judged as one.
 *
 * Its own module because it is a RULE, not a route: `projects_live_branch_chk` and
 * `projects_release_strategy_chk` hold the same rule in Postgres and are the authority, and this
 * exists only so a caller gets a sentence naming what is missing instead of a 500 carrying a
 * constraint name. The two must admit exactly the same rows.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projects, releaseModels, releaseStrategies } from '../db/schema.js';

/**
 * The three PATCH fields this rule judges, declared beside it rather than in the route.
 */
// cm:guard the three are checked TOGETHER by `assertReleaseModelCoherent`, never field by field: the
// rule is `releaseModel = 'promote'` iff a live branch exists, and a PATCH may carry either half
// while the other sits in the row. `projects_live_branch_chk` holds it in Postgres, and the refusal
// here is what turns that constraint into a sentence rather than a 500.
export const releaseModelPatchFields = {
  liveBranch: z.string().trim().max(100).nullable().optional(),
  releaseModel: z.enum(releaseModels).optional(),
  releaseStrategy: z.enum(releaseStrategies).nullable().optional(),
} as const;

/**
 * The one refusal this rule can produce, ANSWERED rather than thrown.
 *
 * The rule does not know it is serving HTTP — the route does, and turns this into a 400. A rule
 * module that built an `HTTPException` would be a second place deciding what a status code means.
 */
export const LIVE_BRANCH_REQUIRED = {
  code: 'LIVE_BRANCH_REQUIRED',
  message:
    'releaseModel `promote` means the release moves code from baseBranch to liveBranch, so a liveBranch is required. Send one, or choose `publish` (the release is an act on a live binding, no ref moves) or `none` (there is no release step).',
} as const;

export type ReleaseModelGap = typeof LIVE_BRANCH_REQUIRED;

/**
 * A PATCH may carry any subset, so the rule is applied to the ROW AS IT WILL BE rather than to the
 * body: `promote` iff a live branch, and a strategy iff `promote`.
 */
// cm:edge contract -> packages/core/src/db/schema.ts — `projects_live_branch_chk` and
// `projects_release_strategy_chk` are the same two rules in Postgres, and they are the authority.
const RELEASE_MODEL_KEYS = ['releaseModel', 'liveBranch', 'releaseStrategy'] as const;

export async function releaseModelGap(
  projectId: string,
  updates: Record<string, unknown>,
): Promise<ReleaseModelGap | null> {
  // A PATCH touching none of the three leaves the row exactly as the two CHECKs already admitted it,
  // so there is nothing to re-judge — and reading the project for every unrelated settings PATCH
  // would buy a query per request to answer a question the body never asked.
  if (!RELEASE_MODEL_KEYS.some((k) => k in updates)) return null;
  const [row] = await db
    .select({
      releaseModel: projects.releaseModel,
      liveBranch: projects.liveBranch,
      releaseStrategy: projects.releaseStrategy,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  const model = (updates.releaseModel as string | undefined) ?? row.releaseModel;
  const live = 'liveBranch' in updates ? (updates.liveBranch as string | null) : row.liveBranch;
  const strategy =
    'releaseStrategy' in updates ? (updates.releaseStrategy as string | null) : row.releaseStrategy;
  if (model === 'promote' && !live) return LIVE_BRANCH_REQUIRED;
  // cm:why the strategy is DERIVED rather than refused when absent: `merge-branch` is what the
  // default procedure already does for all four promote projects, so demanding it would refuse every
  // PATCH that only sets the model. Clearing it off a non-promote model is the same rule read the
  // other way, and `projects_release_strategy_chk` refuses the row either way if this is ever skipped.
  if (model === 'promote' && !strategy) updates.releaseStrategy = 'merge-branch';
  if (model !== 'promote' && strategy) updates.releaseStrategy = null;
  return null;
}

/**
 * The live branch AS A CALLER MAY READ IT: the stored value under `promote`, and `null` under every
 * other model.
 *
 * One function because the rule was being re-decided at each reader, and four of them decided it
 * wrong. The column is deliberately NOT nulled for non-`promote` projects — 25 of the 32 in the
 * fleet carry a value from the era when it defaulted to `'main'`, six of those a real distinct
 * branch, and discarding a declaration a person made is not a migration's call. The price of
 * keeping it is that every reader must ask the model first, and "reading that column without the
 * model" is the exact defect ISS-1046 exists to remove: it is how the retired gate came to answer
 * "this project promotes" for a project that promotes nothing.
 *
 * So: never read `projects.liveBranch` directly outside this function and the row that feeds it.
 * A caller handed a branch under `publish` will act on it — resolve an issue's branches against it,
 * print it to an agent as where the release lands, exclude it from work evidence — and every one of
 * those is the old inference wearing the new column's name.
 */
export function readableLiveBranch(row: {
  releaseModel: string | null;
  liveBranch: string | null;
}): string | null {
  return row.releaseModel === 'promote' ? row.liveBranch : null;
}
