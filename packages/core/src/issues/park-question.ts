// The question a park mints, and the three things that decide whether it does.
//
// Its own module because `apply-transition.ts` is at its line budget and this
// is a self-contained decision — what the transition needs from it is one call.

import { randomUUID } from 'node:crypto';
import type { IssueStatus } from '../db/schema.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { askParkQuestion } from '../questions/write.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';

export interface MintParkQuestionInput {
  issue: { id: string; projectId: string };
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: { needs?: string | undefined; transitionReason?: string | undefined };
}

/**
 * The question a park mints, when the park said what would settle it.
 */
// cm:guard minted in the SAME transaction as the reason comment and the status write, so a park either carries its question or does not commit. A question written afterwards is one a crash between the two leaves nowhere: the issue reads `needs_info` and no surface has a round to show (ISS-996).
// cm:guard the AGENT's park only. A person moving an issue here has stopped the work themselves and owns their own resume — the same line `issues/autonomous-park.ts` draws for the `waiting` rewrite, and drawing it differently in the two places is how one park gets a question and its twin does not.
// cm:guard keyed on `toStatus`, which is the park REWRITE's target: an agent's `waiting` lands on `needs_info` and must mint the same question, and reading `requestedStatus` here would skip exactly those.
export async function mintParkQuestion(input: MintParkQuestionInput, tx: DrizzleTx): Promise<void> {
  const needed = input.options.needs?.trim();
  if (!needed) return;
  if (input.toStatus !== AUTONOMOUS_QUESTION_STATUS) return;
  if (actorAgency(input.actor) !== 'agent') return;
  await askParkQuestion(tx, {
    id: randomUUID(),
    projectId: input.issue.projectId,
    issueId: input.issue.id,
    prompt: input.options.transitionReason?.trim() ?? '',
    needed,
  });
}
