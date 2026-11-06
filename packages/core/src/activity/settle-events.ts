// The event each act a person settles from Needs you writes (ISS-1053), read by the workspace's
// Activity through `ws/broadcast-subscribers.ts:tellOrg`, which marks the project's held glances stale
// (`read.ts:projectMoved`). An act missing here, or an event here that the `org-activity` consumer
// does not read, is a decision that leaves "waiting on you" only once the held glance ages out:
// `settle-events.test.ts` holds every act to an event that consumer reads.

import type { DecisionAct } from '@forge/contracts/needs-you-decisions';
import type { OutboxEventType } from '@forge/contracts/outbox-events';

export const SETTLED_BY: Readonly<Record<DecisionAct, OutboxEventType>> = {
  // the question moves to answered (`questions/answer-record.ts`)
  'question.answer': 'question.transitioned',
  // an accept that re-baselines also moves the requirement; one that does not reports itself
  'revision.accept': 'decision.settled',
  'revision.return': 'requirement.returned',
  'requirement.agree': 'requirement.transitioned',
  'requirement.accept': 'requirement.transitioned',
  'requirement.drop': 'requirement.transitioned',
  'requirement.repin': 'decision.settled',
  'requirement.defer': 'requirement.transitioned',
  'suggestion.accept': 'decision.settled',
  'suggestion.reject': 'decision.settled',
  'feedback.verify': 'feedback.verifySettled',
  'feedback.reopen': 'feedback.verifySettled',
  'release.cut': 'release.cut',
  'release.decide': 'release.approvalDecided',
  // a drafted release's decision settles its approver's row (`release-batch/draft-approval.ts`)
  'release.decideDraft': 'decision.settled',
  'preview.approve': 'preview.transitioned',
  'design.decide': 'workflow.designDecided',
  'mockup.accept': 'mockup.transitioned',
  'mockup.return': 'mockup.transitioned',
  // each re-pinned design is recorded as an approval (`workflows/design-repin-take.ts:takeUnit`)
  'design.repin': 'workflow.designDecided',
  'contract.decide': 'decision.settled',
};
