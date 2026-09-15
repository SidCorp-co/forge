// web-v2 feature module: the structured decision a parked run is waiting on.
//
// Types mirror the EXISTING core endpoints `GET /api/questions?issueId=` and
// `POST /api/questions/:id/answer` (`packages/core/src/questions/routes.ts`,
// shaped by `questions/read.ts:readQuestionsForIssue`) — do NOT guess field
// names. This is the STRUCTURED row, not the agent's prose question, which is a
// comment in the issue thread and stays there.

/** Who may CHOOSE this option. Seeing it is a separate question — every project member sees all of them. */
export type OptionAuthority = "writer" | "admin";
/** How far the choice reaches. */
export type OptionBinding = "this_call" | "session" | "project";
/** Who carries the choice out once it is made. */
export type OptionExecutor = "agent" | "core" | "human";

export type QuestionStatus = "open" | "answered" | "void" | "expired" | "needs_info";
export type BlockerKind = "machine" | "master_or_peer" | "human";

export interface QuestionOption {
  id: string;
  label: string;
  authority: OptionAuthority;
  bindsTo: OptionBinding;
  executedBy: OptionExecutor;
  fingerprint?: string;
}

/** An option on the CURRENT round, carrying the server's own lock verdict. */
export interface VisibleOption extends QuestionOption {
  // cm:guard the SERVER's verdict, rendered and never re-derived from the caller's role in the client — two authorities disagreeing is how a lock becomes decorative, and this client has no access to the org-derived half of the rule anyway (ISS-964 criterion 15).
  locked: boolean;
}

/** How a round is answered: by picking one of its options, or in words. */
export type AnswerShape = "choice" | "free_text";

interface StepCommon {
  round: number;
  prompt: string;
  askedAt: string;
  answeredAt?: string;
  answeredBy?: string;
}

export interface ChoiceStep extends StepCommon {
  answerShape: "choice";
  options: QuestionOption[];
  recommendedOptionId: string;
  chosenOptionId?: string;
}

export interface FreeTextStep extends StepCommon {
  answerShape: "free_text";
  /** What the run said it needs to know. Never empty — core writes a stated fallback. */
  needed: string;
  answerText?: string;
}

/** One round of one decision. A follow-up is another step on the same row, never a second row. */
export type QuestionStep = ChoiceStep | FreeTextStep;

// cm:guard a step written before ISS-996 carries no `answerShape` and is a CHOICE round; the untagged case is read off `options` and never off an empty option list on a tagged step, because a free-text round and a choice round whose options failed to write both present as zero options (ISS-996).
// cm:edge contract -> packages/core/src/db/schema-questions.ts — `isChoiceStep` is the same predicate on the server, and the two must agree on the untagged row or a screen draws the wrong control over a live decision.
export function isChoiceStep(step: QuestionStep): step is ChoiceStep {
  if (step.answerShape === "choice") return true;
  const untagged = step as { answerShape?: AnswerShape; options?: unknown };
  return untagged.answerShape === undefined && Array.isArray(untagged.options);
}

export interface AgentQuestion {
  id: string;
  projectId: string;
  issueId: string | null;
  status: QuestionStatus;
  blockerKind: BlockerKind;
  // cm:guard `steps` is the WHOLE history and the project queue does not send it: `GET /api/questions?projectId=` drops it and sends `currentStep` plus `rounds` instead, because it used to return every round of every open decision in one unpaged response (ISS-1022). Read the live round through `currentRoundOf`, never off this array.
  steps?: QuestionStep[];
  /** The live round, on the rows the project queue sends. The issue-scoped read sends `steps` instead. */
  currentStep?: QuestionStep | null;
  /** How many rounds the decision has had. Present wherever `steps` is not. */
  rounds?: number;
  maxRounds: number;
  voidReason: string | null;
  endedReason: string | null;
  parkDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** How the CURRENT round is answered. Read this, never the length of `options`. */
  answerShape: AnswerShape;
  /** The CURRENT round's options, each with the server's `locked` verdict. Empty on a free-text round. */
  options: VisibleOption[];
  recommendedOptionId: string;
  /** What the run needs to be told, on a free-text round. Empty string on a choice round. */
  needed: string;
  // cm:guard the server's verdict on whether THIS reader may answer the current free-text round; always `false` on a choice round, where the per-option `locked` carries it instead (ISS-996).
  locked: boolean;
}

export interface QuestionListResponse {
  questions: AgentQuestion[];
  /** Every question matching the filter, uncapped by the page. Absent on the issue-scoped read. */
  total?: number;
  /** Whether a further page remains. Absent on the issue-scoped read. */
  hasMore?: boolean;
  /** Where the next page starts. Opaque — pass it back, never parse it. Null on the last page. */
  nextCursor?: string | null;
}

// cm:guard the ONE place either shape is resolved to the live round, so a caller cannot read `steps` on a row that has none and render `undefined`: the issue-scoped read sends the whole history and the project queue sends `currentStep` alone (ISS-1022).
export function currentRoundOf(question: AgentQuestion): QuestionStep | undefined {
  return question.steps?.[question.steps.length - 1] ?? question.currentStep ?? undefined;
}

/** The rounds BEFORE the live one, which only the issue-scoped read carries. */
export function earlierRoundsOf(question: AgentQuestion): QuestionStep[] {
  return question.steps ? question.steps.slice(0, -1) : [];
}

/** How many rounds the decision has had, from whichever of the two shapes arrived. */
export function roundCountOf(question: AgentQuestion): number {
  return question.steps?.length ?? question.rounds ?? (question.currentStep ? 1 : 0);
}

// cm:guard exactly ONE of `optionId` and `text` — core refuses a body carrying both rather than picking one, because a caller that sent both does not know which round it is answering (ISS-996).
export type GivenAnswer = { optionId: string; text?: never } | { text: string; optionId?: never };

export type AnswerInput = GivenAnswer & {
  questionId: string;
  /** The round the person was looking at. Core refuses an answer bound to any other. */
  round: number;
};
