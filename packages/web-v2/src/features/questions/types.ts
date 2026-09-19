
export type OptionAuthority = "writer" | "admin";
export type OptionBinding = "this_call" | "session" | "project";
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

export interface VisibleOption extends QuestionOption {
  locked: boolean;
}

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
  needed: string;
  answerText?: string;
}

/** One round of one decision. A follow-up is another step on the same row, never a second row. */
export type QuestionStep = ChoiceStep | FreeTextStep;

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

export type GivenAnswer = { optionId: string; text?: never } | { text: string; optionId?: never };

export type AnswerInput = GivenAnswer & {
  questionId: string;
  /** The round the person was looking at. Core refuses an answer bound to any other. */
  round: number;
};
