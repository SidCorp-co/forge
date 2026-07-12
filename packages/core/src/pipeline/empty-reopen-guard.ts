/**
 * ISS-635 — Guard against dispatching forge-fix on a `reopen` with zero
 * prior implementation work. A `reopen` with no prior `code`/`fix` job has
 * no branch/commit for forge-fix to patch — dispatching it burns a runner
 * slot on a no-op. `considerEnqueue` routes this case to `needs_info`
 * instead; this module posts the operator-facing comment (mirrors the
 * `missing-skill-guard.ts` refuse+comment pattern).
 */

import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { logger } from '../logger.js';

export function buildEmptyReopenCommentBody(): string {
  return [
    '🛑 **`reopen` has no prior implementation to fix**',
    '',
    'This issue was reopened but has never had a `code` or `fix` job run — there is no ' +
      'branch or commit for forge-fix to patch.',
    '',
    'Routed to `needs_info` for human triage instead of dispatching an empty fix.',
  ].join('\n');
}

/**
 * Insert an operator-facing comment authored by the project creator
 * (audit-only, same convention as `postMissingSkillComment`). No-op when
 * the caller has no resolvable creator id.
 */
export async function postEmptyReopenComment(args: {
  issueId: string;
  authorId: string | null;
}): Promise<void> {
  if (!args.authorId) return;
  try {
    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: args.authorId,
      body: buildEmptyReopenCommentBody(),
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId },
      'empty-reopen-guard: failed to post comment, continuing',
    );
  }
}
