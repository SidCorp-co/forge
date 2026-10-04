import { eq } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../observability/logger.js';
import type { TransitionActor } from './actor-agency.js';
import type { TransitionIssueRow } from './apply-transition.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';

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
    const label = blocker
      ? formatIssueRef(await activeIssuePrefix(issue.projectId), blocker.issSeq)
      : issue.id;
    const authorId = actor.type === 'user' ? actor.id : actor.ownerId;
    for (const dependent of dependents) {
      await postIssueNotice({
        issueId: dependent.issueId,
        authorId,
        body: `Unblocked — ${label} was dropped, so its \`blocks\` edge on this issue expired and this issue can dispatch. \`merged_at\` was NOT stamped on ${label}: dropped means the work will not happen, not that it shipped. If this issue genuinely needs that work, re-point the dependency rather than letting it proceed.`,
      });
    }
  } catch (error) {
    logger.warn(
      { error, issueId: issue.id, dependents: dependents.length },
      'transition: drop-unblock audit comments failed (transition already committed)',
    );
  }
}
