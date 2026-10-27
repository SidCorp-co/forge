import { STANDING_QUESTION_STATUSES } from "@forge/contracts/status-sets";
import type { BlockerKind, QuestionStatus } from "./types";

/** Who a question waits on and whether it is answered, in words: no stored value is shown (ISS-1421 r38).
 *  One that is over is said in the past: it no longer waits on anyone. */
const WHO: Record<BlockerKind, string> = {
  human: "a person",
  master_or_peer: "another agent",
  machine: "an automated check",
};

export const ANSWERED_STATE: Record<QuestionStatus, string> = {
  open: "not answered yet",
  answered: "answered",
  void: "withdrawn",
  expired: "expired unanswered",
  needs_info: "waiting on more information",
};

const STILL_WAITING: ReadonlySet<string> = new Set(STANDING_QUESTION_STATUSES);

export function questionStateLine(kind: BlockerKind, status: QuestionStatus): string {
  const lead = STILL_WAITING.has(status) ? "Waits on" : "Asked of";
  return `${lead} ${WHO[kind]} · ${ANSWERED_STATE[status]}`;
}
