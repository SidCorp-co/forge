// The question every agent park mints, and the two things that decide whether
// it does.
//
// Its own module because `apply-transition.ts` is at its line budget and this
// is a self-contained decision — what the transition needs from it is one call.

import { randomUUID } from 'node:crypto';
import type { IssueStatus } from '../db/schema.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { askParkQuestion } from '../questions/write.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';

// cm:guard EVERY agent park mints a question, and a park that did not say what would settle it gets this sentence rather than no question: the comment lane is gone, so a park with nothing to answer is a park nobody can resume. It states that the agent did not say — which is true, is actionable, and is NOT a guess at what the agent needed (ISS-996).
export const NEED_NOT_STATED =
  'the run did not say what would settle this — answer with whatever it needs to carry on';

export interface MintParkQuestionInput {
  issue: { id: string; projectId: string };
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: { needs?: string | undefined; transitionReason?: string | undefined };
}

/**
 * Mint the question this park is answered through.
 */
// cm:guard minted in the SAME transaction as the reason comment and the status write, so a park either carries its question or does not commit. A question written afterwards is one a crash between the two leaves nowhere: the issue reads `needs_info` and no surface has a round to show (ISS-996).
// cm:guard the AGENT's park only. A person moving an issue here has stopped the work themselves and owns their own resume — the same line `issues/autonomous-park.ts` draws for the `waiting` rewrite, and drawing it differently in the two places is how one park gets a question and its twin does not.
// cm:guard keyed on `toStatus`, which is the park REWRITE's target: an agent's `waiting` lands on `needs_info` and must mint the same question, and reading `requestedStatus` here would skip exactly those.
export async function mintParkQuestion(input: MintParkQuestionInput, tx: DrizzleTx): Promise<void> {
  if (input.toStatus !== AUTONOMOUS_QUESTION_STATUS) return;
  if (actorAgency(input.actor) !== 'agent') return;
  await askParkQuestion(tx, {
    id: randomUUID(),
    projectId: input.issue.projectId,
    issueId: input.issue.id,
    prompt: input.options.transitionReason?.trim() ?? '',
    needed: input.options.needs?.trim() || NEED_NOT_STATED,
  });
}

/**
 * Why this park minted nothing, for a caller that asked it to.
 */
// cm:guard the answer to `needs` reaching no reader is a SENTENCE, never a refusal: `needs_info` is the escape hatch a stuck run takes, and a door that rejects the park itself strands the run over a field that is optional. It is also never silence — nothing in the product sends `needs` except a tool caller (the web UI has no such field), so a `needs` that mints nothing is a caller who believes a person was asked and will wait for an answer that was never on the record (ISS-996).
export function parkQuestionNotMinted(input: MintParkQuestionInput): string | null {
  if (!input.options.needs?.trim()) return null;
  if (input.toStatus !== AUTONOMOUS_QUESTION_STATUS) {
    return `\`needs\` was sent with \`${input.toStatus}\`, which mints no question — only \`${AUTONOMOUS_QUESTION_STATUS}\` does. What you sent is on no record; put it in \`reason\`, or park at \`${AUTONOMOUS_QUESTION_STATUS}\` instead.`;
  }
  if (actorAgency(input.actor) !== 'agent') {
    return `\`needs\` was sent on a credential owned by a person, which mints no question — a person parking their own work owns their own resume. Nobody has been asked anything. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.`;
  }
  return null;
}
