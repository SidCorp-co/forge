// The event each act a person settles from Needs you writes (ISS-1053), read by the workspace's
// Activity through `ws/broadcast-subscribers.ts:tellOrg`, which marks the project's held glances stale
// (`read.ts:projectMoved`). An act missing here, or an event here that the `org-activity` consumer
// does not read, is a decision that leaves "waiting on you" only once the held glance ages out:
// `settle-events.test.ts` holds every act to an event that consumer reads.

import type { DecisionAct } from '@forge/contracts/needs-you-decisions';
import type { OutboxEventType } from '@forge/contracts/outbox-events';

export const SETTLED_BY: Readonly<Record<DecisionAct, OutboxEventType>> = {
  // the answer's own event, which carries what was said (`questions/answer-record.ts`, ISS-1181)
  'question.answer': 'question.answered',
  // an accept that re-baselines is its `requirement.agreed`; one that does not reports itself
  'revision.accept': 'decision.settled',
  'revision.return': 'requirement.returned',
  'requirement.agree': 'requirement.agreed',
  'requirement.accept': 'requirement.accepted',
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
  // a production deploy's confirm settles its person's row (`release-batch/coolify-prod-gate.ts`)
  'release.confirmDeploy': 'decision.settled',
  'preview.approve': 'preview.transitioned',
  'design.decide': 'workflow.designDecided',
  'mockup.accept': 'mockup.transitioned',
  'mockup.return': 'mockup.transitioned',
  // each re-pinned design is recorded as an approval (`workflows/design-repin-take.ts:takeUnit`)
  'design.repin': 'workflow.designDecided',
  // a return reports itself; an approval is its `contract.versionApproved` (ISS-1181)
  'contract.decide': 'decision.settled',
};
