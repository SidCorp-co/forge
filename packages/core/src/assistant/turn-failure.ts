// Why a turn ended without its answer, as its window records it: the code, the cause, and one
// English sentence for the record a reader of the conversation's history sees. None of it is said
// in the room: the person is told only core's one plain Vietnamese last-resort line
// (`conversations/last-resort.ts`, ISS-875).

import type { AssistantTurnFailureCode } from '@forge/contracts/conversations';

export type TurnFailureCode = AssistantTurnFailureCode;

/** Why a turn ended without its answer: the provider, a crash, or the clock. */
export type TurnFailureCause = 'provider' | 'crash' | 'timeout';

const REASON: Record<TurnFailureCode, (name: string) => string> = {
  ASSISTANT_TURN_TIMED_OUT: (name) =>
    `${name} ran out of time before it finished an answer, so nothing was sent. Ask again, or ask for one thing at a time.`,
  ASSISTANT_TURN_FAILED: (name) =>
    `${name} could not reach its model, so nothing was sent. Please ask again in a few minutes.`,
};

/** The reason a window records for a failed turn: the sentence, the code beside it. */
export function turnFailureReason(code: TurnFailureCode, name: string): string {
  return REASON[code](name);
}
