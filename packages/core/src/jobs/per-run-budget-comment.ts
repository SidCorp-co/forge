/**
 * W2.3.3 (ISS-210) — operator-facing comment after a per-run budget kill.
 *
 * Sibling of `postBudgetExhaustedComment` (monthly cap, W2.3.2). Kept as a
 * separate helper because the trigger conditions + comment body diverge
 * enough that one combined helper would carry conditional formatting and
 * become noise.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues, projects } from '../db/schema.js';
import type { JobType } from '../db/schema.js';
import { logger } from '../logger.js';

export interface PostPerRunBudgetExceededCommentInput {
  issueId: string;
  jobType: JobType;
  /** Optional structured metadata posted alongside the /fail body. Shape:
   *  `{ spent: number; limit: number; perRunUsd: number; model: string }`. */
  failureMeta: Record<string, unknown> | null;
}

/**
 * Post a comment on the issue explaining the per-run budget kill. Author is
 * the project owner so the comment carries a real `author_id` (issue-level
 * comments are not nullable on that column). No-op if the issue (or its
 * project owner) cannot be resolved.
 */
export async function postPerRunBudgetExceededComment(
  input: PostPerRunBudgetExceededCommentInput,
): Promise<void> {
  const [row] = await db
    .select({ ownerId: projects.ownerId })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, input.issueId))
    .limit(1);
  if (!row?.ownerId) return;

  const meta = input.failureMeta ?? {};
  const spent = typeof meta.spent === 'number' ? meta.spent : null;
  const limit = typeof meta.limit === 'number' ? meta.limit : null;
  const perRunUsd = typeof meta.perRunUsd === 'number' ? meta.perRunUsd : null;
  const model = typeof meta.model === 'string' ? meta.model : 'unknown';

  const spentStr = spent !== null ? `$${spent.toFixed(4)}` : 'unknown';
  const limitStr = limit !== null ? `$${limit.toFixed(4)}` : 'unknown';
  const perRunStr = perRunUsd !== null ? `$${perRunUsd.toFixed(4)}` : 'unknown';

  const body = [
    '🚫 **Killed by per-run budget**',
    '',
    `**Stage:** \`${input.jobType}\``,
    `**Spent:** ${spentStr}`,
    `**Limit:** ${limitStr} (perRunUsd × 1.5 = ${perRunStr} × 1.5)`,
    `**Model:** ${model}`,
    '',
    'Re-trigger manually after investigation.',
  ].join('\n');

  try {
    await db.insert(comments).values({
      issueId: input.issueId,
      authorId: row.ownerId,
      body,
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId },
      'per-run-budget-comment: failed to insert, continuing',
    );
  }
}
