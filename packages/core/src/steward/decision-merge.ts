// The merge a steward decision on a draft issue carries out (REQ-48 BC-5; Issue lifecycle `draft`):
// the draft's text goes to the live issue it repeats as a comment, written as the answerer in the
// drop's own transaction. A merge moves text, never edges or carried feedback, so a draft that holds
// a live `blocks` edge or carries feedback is refused by name rather than dropped with them stranded.

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import { type StewardRefusalCode, stewardMergeOf } from '@forge/contracts/steward';
import { and, eq } from 'drizzle-orm';
import { insertComment } from '../comments/index.js';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedbackCarriedBy } from '../feedback/index.js';
import { draftMergeHolds, issueIdOfKey } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import type { StewardDecisionAnswer } from '../questions/index.js';

const refuse = refuser<StewardRefusalCode>('STEWARD_MERGE_TARGET_ENDED');

export interface MergePlan {
  targetId: string;
  targetKey: string;
  /** The comment on the target, in the drop's transaction. */
  write(tx: Tx): Promise<void>;
}

/** Where the draft's merge goes and what it carries, or a refusal naming the rule it breaks. */
export async function mergePlanOf(
  d: StewardDecisionAnswer,
  issue: { id: string; projectId: string; title: string; description: string | null },
  key: string,
  said: string,
): Promise<MergePlan> {
  const into = stewardMergeOf(d.optionId)?.into;
  if (!into) throw new Error(`steward: merge option ${d.optionId} names no issue`);
  const targetId = await issueIdOfKey(into, issue.projectId);
  const [target] = targetId
    ? await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, targetId), eq(issues.projectId, issue.projectId)))
        .limit(1)
    : [];
  if (
    !target ||
    target.id === issue.id ||
    ISSUE_TERMINAL_STATUSES.includes(target.status as IssueStatus)
  ) {
    throw refuse(
      'STEWARD_MERGE_TARGET_ENDED',
      `${into} is ${target ? (target.id === issue.id ? `${key} itself` : target.status) : 'no issue of this project'}, so there is no live issue to merge ${key} into; void the question (POST /api/questions/${d.questionId}/void) and let the steward ask again`,
      '/optionId',
    );
  }
  const holds = [...(await draftMergeHolds(issue.id)), ...(await feedbackCarriedBy(issue.id))];
  if (holds.length > 0) {
    throw refuse(
      'STEWARD_MERGE_HAS_DEPENDENTS',
      `${key} is linked from ${holds.join(', ')}; a merge moves its text, not those links, so dropping it would leave them pointing at a dropped issue: answer drop or keep, or move the links first`,
      '/optionId',
    );
  }
  const description = issue.description?.trim();
  const body = [
    `Merged from ${key} "${issue.title}" on ${said}; ${key} is dropped.`,
    ...(description ? ['', description] : []),
  ].join('\n');
  return {
    targetId: target.id,
    targetKey: into,
    write: async (tx) => {
      await insertComment(
        {
          issueId: target.id,
          authorId: d.by,
          authorDeviceId: null,
          parentId: null,
          intent: 'note',
          writtenLang: null,
          body,
        },
        tx,
      );
    },
  };
}
