// What an ask names as about (FB-149): resolved and stored as `about`, or refused by name, at both
// doors that write a question, the ask and the park (`write.ts`).

import type {
  QuestionAbout,
  QuestionAboutRequest,
  QuestionRefusalCode,
} from '@forge/contracts/questions';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { IssueDependencyExecutor } from '../issues/index.js';
import { refuser } from '../lib/refusal.js';
import { feedbackAbout } from './about-feedback.js';
import type { AwaitedDesign } from './design-wait.js';
import type { AwaitedMerge } from './merge-wait.js';
import { contractAboutRefusal, requirementIdIn } from './ports.js';

const refuse = refuser<QuestionRefusalCode>('QUESTION_REFUSED');

/**
 * A question that waits on a fact is answered by that fact, never by a person's business answer, so
 * it is about nothing: refused by name on both doors that write one, the ask and the park.
 */
export function refuseAboutOnWait(input: {
  about?: unknown;
  awaitsMerge?: AwaitedMerge | undefined;
  awaitsDesign?: AwaitedDesign | undefined;
}): void {
  if (!input.about) return;
  if (input.awaitsMerge) {
    throw refuse(
      'QUESTION_ABOUT_ON_MERGE_WAIT',
      `this question waits on issue ${input.awaitsMerge.issueId}'s merge mark, which answers it with the mark itself; a business question \`about\` a requirement or a contract is answered by a person, and its answer becomes a decision there. Ask the business question on its own, and park on the mark without \`about\``,
      '/about',
    );
  }
  if (input.awaitsDesign) {
    throw refuse(
      'QUESTION_ABOUT_ON_DESIGN_WAIT',
      `this question waits on the decision on design revision ${input.awaitsDesign.revision} of workflow ${input.awaitsDesign.workflowId}, which answers it with the decision itself; a business question \`about\` a requirement or a contract is answered by a person, and its answer becomes a decision there. Ask the business question on its own, and park on the design without \`about\``,
      '/about',
    );
  }
}

/**
 * The stored `about` an ask names, or a refusal naming what it could not resolve: a requirement of
 * another project or none, `requirement: null` on a question no delivering issue carries, or a
 * contract the project neither publishes nor consumes, or a feedback item that is not this project's.
 */
export async function resolveAbout(
  executor: IssueDependencyExecutor,
  input: { projectId: string; issueId?: string | undefined },
  about: QuestionAboutRequest | { feedbackId: string },
): Promise<QuestionAbout> {
  if ('feedbackId' in about) return feedbackAbout(executor, input.projectId, about.feedbackId);
  if ('contract' in about) {
    const refusal = await contractAboutRefusal(input.projectId, about.contract);
    if (refusal) throw refuse('QUESTION_ABOUT_UNKNOWN', refusal, '/about/contract');
    return { kind: 'contract', contract: about.contract };
  }
  if (about.requirement !== null) {
    const requirementId = await requirementIdIn(executor as Tx, input.projectId, about.requirement);
    if (!requirementId) {
      throw refuse(
        'QUESTION_ABOUT_UNKNOWN',
        `\`about.requirement\` is \`${about.requirement}\`, which names no requirement of this project — name one by its key (REQ-n) or id`,
        '/about/requirement',
      );
    }
    return { kind: 'requirement', requirementId };
  }
  const [issue] = input.issueId
    ? await executor
        .select({ requirementId: issues.requirementId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .limit(1)
    : [];
  if (!issue?.requirementId) {
    throw refuse(
      'QUESTION_ABOUT_NO_REQUIREMENT',
      input.issueId
        ? `\`about.requirement\` is null, which names the requirement issue ${input.issueId} delivers, and it delivers none — name the requirement by its key (REQ-n), or link the issue to it first`
        : '`about.requirement` is null, which names the requirement of the issue asked on, and this question is asked on no issue — name the requirement by its key (REQ-n)',
      '/about/requirement',
    );
  }
  return { kind: 'requirement', requirementId: issue.requirementId };
}
