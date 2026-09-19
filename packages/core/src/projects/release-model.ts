import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projects, releaseModels, releaseStrategies } from '../db/schema.js';

/**
 * The three PATCH fields this rule judges, declared beside it rather than in the route.
 */
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
const RELEASE_MODEL_KEYS = ['releaseModel', 'liveBranch', 'releaseStrategy'] as const;

export async function releaseModelGap(
  projectId: string,
  updates: Record<string, unknown>,
): Promise<ReleaseModelGap | null> {
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
  if (model === 'promote' && !strategy) updates.releaseStrategy = 'merge-branch';
  if (model !== 'promote' && strategy) updates.releaseStrategy = null;
  return null;
}

export function readableLiveBranch(row: {
  releaseModel: string | null;
  liveBranch: string | null;
}): string | null {
  return row.releaseModel === 'promote' ? row.liveBranch : null;
}
