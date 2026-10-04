import { randomUUID } from 'node:crypto';
import { AUTONOMOUS_QUESTION_STATUS } from '@forge/contracts/issue-machine';
import type { IssueStatus } from '../db/schema.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';
import { askParkQuestion, personOwesAnAnswer } from './ports.js';

export const NEED_NOT_STATED =
  'the run did not say what would settle this — answer with whatever it needs to carry on';

export interface MintParkQuestionInput {
  issue: { id: string; projectId: string };
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: {
    needs?: string | undefined;
    transitionReason?: string | undefined;
    reason?: string | undefined;
  };
}

/** Whether a park at this status is answered through a question: `needs_info`, whatever its kind
 *  (the old `waiting` park folded in with its kind, ISS-54). */
function mintsAt(toStatus: IssueStatus): boolean {
  return toStatus === AUTONOMOUS_QUESTION_STATUS;
}

/**
 * Mint the question this park is answered through — unless the park names no need
 * and a person already owes the issue an answer, which is the question it waits on.
 */
export async function mintParkQuestion(input: MintParkQuestionInput, tx: DrizzleTx): Promise<void> {
  const needs = input.options.needs?.trim();
  if (!mintsAt(input.toStatus)) return;
  if (actorAgency(input.actor) !== 'agent') return;
  if (!needs && (await personOwesAnAnswer(tx, input.issue.id))) return;
  await askParkQuestion(tx, {
    id: randomUUID(),
    projectId: input.issue.projectId,
    issueId: input.issue.id,
    prompt: input.options.transitionReason?.trim() || input.options.reason?.trim() || '',
    needed: needs || NEED_NOT_STATED,
  });
}

/**
 * Why this park minted nothing, for a caller that asked it to.
 */
export function parkQuestionNotMinted(input: MintParkQuestionInput): string | null {
  if (!input.options.needs?.trim()) return null;
  if (!mintsAt(input.toStatus)) {
    return `\`needs\` was sent with \`${input.toStatus}\`, which mints no question — only \`${AUTONOMOUS_QUESTION_STATUS}\` does. What you sent is on no record; put it in \`reason\`, or park at \`${AUTONOMOUS_QUESTION_STATUS}\` instead.`;
  }
  if (actorAgency(input.actor) !== 'agent') {
    return `\`needs\` was sent on a credential owned by a person, which mints no question — a person parking their own work owns their own resume. Nobody has been asked anything. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.`;
  }
  return null;
}
