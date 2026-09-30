import { randomUUID } from 'node:crypto';
import type { IssueStatus } from '../db/schema.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { personOwesAnAnswer } from '../questions/issue-coupling.js';
import { askParkQuestion } from '../questions/write.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';

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

/** A `waiting` park asks a person for a decision or a resource; it is answered the same way when it says what would settle it (ISS-1310). */
const ASKS_WITH_NEEDS: IssueStatus = 'waiting';

/** Whether a park at this status takes a question from what `needs` says. */
function mintsAt(toStatus: IssueStatus, needs: string | undefined): boolean {
  return (
    toStatus === AUTONOMOUS_QUESTION_STATUS || (toStatus === ASKS_WITH_NEEDS && Boolean(needs))
  );
}

/**
 * Mint the question this park is answered through — unless the park names no need
 * and a person already owes the issue an answer, which is the question it waits on.
 * A `needs_info` park always asks; a `waiting` park asks when it names what it needs.
 */
export async function mintParkQuestion(input: MintParkQuestionInput, tx: DrizzleTx): Promise<void> {
  const needs = input.options.needs?.trim();
  if (!mintsAt(input.toStatus, needs)) return;
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
  if (!mintsAt(input.toStatus, input.options.needs.trim())) {
    return `\`needs\` was sent with \`${input.toStatus}\`, which mints no question — only \`${AUTONOMOUS_QUESTION_STATUS}\` and \`${ASKS_WITH_NEEDS}\` do. What you sent is on no record; put it in \`reason\`, or park at one of those instead.`;
  }
  if (actorAgency(input.actor) !== 'agent') {
    return `\`needs\` was sent on a credential owned by a person, which mints no question — a person parking their own work owns their own resume. Nobody has been asked anything. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.`;
  }
  return null;
}
