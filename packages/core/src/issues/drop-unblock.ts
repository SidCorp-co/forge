import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { TransitionActor } from './actor-agency.js';
import type { TransitionIssueRow } from './apply-transition.js';
import type { UnblockedDependent } from './drop-cascade.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { closeOpenRunForIssue, postIssueNotice } from './ports.js';
import { publishPipelineHealthChanged } from './pipeline-health.js';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { consume } from '../outbox/index.js';

/** The dependents a drop unblocked are told so, in the drop's own transaction. */
export async function postDropUnblockNotices(
  tx: Tx,
  issue: TransitionIssueRow,
  dependents: UnblockedDependent[],
  actor: TransitionActor,
): Promise<void> {
  if (dependents.length === 0) return;
  const [blocker] = await tx
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, issue.id))
    .limit(1);
  const label = blocker
    ? formatIssueRef(await activeIssuePrefix(issue.projectId), blocker.issSeq)
    : issue.id;
  const authorId = actor.type === 'user' ? actor.id : actor.ownerId;
  for (const dependent of dependents) {
    await postIssueNotice(
      {
        issueId: dependent.issueId,
        authorId,
        body: `Unblocked — ${label} was dropped, so its \`blocks\` edge on this issue expired and this issue can dispatch. \`merged_at\` was NOT stamped on ${label}: dropped means the work will not happen, not that it shipped. If this issue genuinely needs that work, re-point the dependency rather than letting it proceed.`,
      },
      tx,
    );
  }
}

/** A move's reactions outside its row: the pipeline health it changed and, at a terminal status,
 *  the run it closes. Redelivered with backoff until both hold. */
export function registerIssueMoveReactions(): void {
  consume('issue.transitioned', {
    name: 'issue-move-reactions',
    handle: async (p) => {
      await publishPipelineHealthChanged(p.projectId, [p.id]);
      if (ISSUE_TERMINAL_STATUSES.includes(p.to)) await closeOpenRunForIssue(p.id, 'completed');
    },
  });
}
