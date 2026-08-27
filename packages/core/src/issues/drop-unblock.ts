import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { logger } from '../logger.js';
import type { TransitionActor, TransitionIssueRow } from './apply-transition.js';
import type { UnblockedDependent } from './drop-cascade.js';

export async function recordDropUnblock(
  issue: TransitionIssueRow,
  dependents: UnblockedDependent[],
  actor: TransitionActor,
): Promise<void> {
  try {
    const [blocker] = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .limit(1);
    const label = blocker ? `ISS-${blocker.issSeq}` : issue.id;
    const authorId = actor.type === 'user' ? actor.id : actor.ownerId;
    // cm:guard write this on each DEPENDENT, never only on the dropped issue. The question it answers — "why did this start?" — is asked on the issue that moved, and once the edge is expired no surface in this repo can still show the pair.
    await db.insert(comments).values(
      dependents.map((dependent) => ({
        issueId: dependent.issueId,
        authorId,
        body: `Unblocked — ${label} was dropped, so its \`blocks\` edge on this issue expired and this issue can dispatch. \`merged_at\` was NOT stamped on ${label}: dropped means the work will not happen, not that it shipped. If this issue genuinely needs that work, re-point the dependency rather than letting it proceed.`,
        parentId: null,
        isAi: true,
      })),
    );
  } catch (error) {
    logger.warn(
      { error, issueId: issue.id, dependents: dependents.length },
      'transition: drop-unblock audit comments failed (transition already committed)',
    );
  }
}
