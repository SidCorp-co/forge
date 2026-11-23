// How the owner's word in a room makes each act his Needs you can owe (ISS-1299, owner 2026-11-18:
// the agent promised an ecosystem link no door let it make). Every decision act
// a Needs-you button performs (`@forge/contracts/needs-you-decisions:DECISION_ACTS`) is listed here
// with the room's tool that makes it as him: an owner act (`owner-forge-act.ts`), `answer_question`
// or `release_decision`; or, where no door from chat exists yet, `null` with the page it is made on.
// The table is typed over every decision act, so a new Needs-you act cannot ship without saying how a
// room reaches it, and an act with no door is refused by name rather than promised.

import type { DecisionAct } from '@forge/contracts/needs-you-decisions';
import type { SupportForgeAct } from '@forge/contracts/support-channel';

export type ChatDoor =
  | { tool: 'owner_forge_act'; acts: readonly SupportForgeAct[] }
  | { tool: 'answer_question' | 'release_decision' }
  | { tool: null; page: string };

const owner = (...acts: SupportForgeAct[]): ChatDoor => ({ tool: 'owner_forge_act', acts });
const page = (where: string): ChatDoor => ({ tool: null, page: where });

/** Each Needs-you decision act, and how a room makes it on the owner's word. */
export const CHAT_DOOR_OF_DECISION: Readonly<Record<DecisionAct, ChatDoor>> = {
  'question.answer': { tool: 'answer_question' },
  'revision.accept': owner('requirement.accept'),
  'revision.return': owner('requirement.return'),
  'requirement.agree': owner('requirement.agree'),
  'requirement.accept': owner('requirement.accept_delivery'),
  'requirement.drop': owner('requirement.drop'),
  'requirement.defer': owner('requirement.defer'),
  'requirement.repin': page("the requirement's page (Update to the design)"),
  'suggestion.accept': owner('suggestion.accept'),
  'suggestion.reject': owner('suggestion.reject'),
  'feedback.verify': owner('feedback.verify'),
  'feedback.reopen': owner('feedback.reopen'),
  'release.cut': owner('release.cut'),
  'release.decide': { tool: 'release_decision' },
  'release.decideDraft': { tool: 'release_decision' },
  'release.confirmDeploy': owner('release.confirmDeploy'),
  'preview.approve': page("the preview's page"),
  'design.decide': owner('workflow.approve', 'workflow.return'),
  'mockup.accept': owner('mockup.accept'),
  'mockup.return': owner('mockup.return'),
  'design.repin': page("the workflow's design page"),
  'contract.decide': page("the contract's page"),
};

/** The decision act `act` names, where it is one: `mockup.accept` is, `question.close` is not. */
export function doorOfDecision(act: string): ChatDoor | null {
  return Object.hasOwn(CHAT_DOOR_OF_DECISION, act)
    ? CHAT_DOOR_OF_DECISION[act as DecisionAct]
    : null;
}
