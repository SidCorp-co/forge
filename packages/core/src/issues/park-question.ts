import { randomUUID } from 'node:crypto';
import type { IssueStatus } from '../db/schema.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { askParkQuestion } from '../questions/write.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';

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
