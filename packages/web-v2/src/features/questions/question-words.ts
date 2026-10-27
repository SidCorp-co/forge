import type { BlockerKind, QuestionStatus } from "./types";

/** Who a question waits on and whether it is answered, in words: no stored value is shown (ISS-1421 r38). */
export const WAITS_ON: Record<BlockerKind, string> = {
  human: "Waits on a person",
  master_or_peer: "Waits on another agent",
  machine: "Waits on an automated check",
};

export const ANSWERED_STATE: Record<QuestionStatus, string> = {
  open: "not answered yet",
  answered: "answered",
  void: "withdrawn",
  expired: "expired unanswered",
  needs_info: "waiting on more information",
};

export function questionStateLine(kind: BlockerKind, status: QuestionStatus): string {
  return `${WAITS_ON[kind]} · ${ANSWERED_STATE[status]}`;
}
