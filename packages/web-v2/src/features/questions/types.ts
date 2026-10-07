import type { AnswerHold, AnswerResume } from "@forge/contracts/questions";


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
  /** What the answer said the issue still waits on. */
  hold?: AnswerHold;
  /** What the answer did to the issue it stopped, once core recorded it. */
  resume?: AnswerResume;
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
  currentStep?: QuestionStep | null;
  rounds?: number;
  maxRounds: number;
  voidReason: string | null;
  endedReason: string | null;
  parkDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  answerShape: AnswerShape;
  options: VisibleOption[];
  recommendedOptionId: string;
  needed: string;
  locked: boolean;
  origin?: { kind: string; documentId?: string; number?: string } | null;
  /** The issue whose merge mark answers this question, by its key; recording the mark answers it. */
  awaitsMerge?: { issueId: string; key: string } | null;
}

export interface QuestionListResponse {
  questions: AgentQuestion[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

export function currentRoundOf(question: AgentQuestion): QuestionStep | undefined {
  return question.steps?.[question.steps.length - 1] ?? question.currentStep ?? undefined;
}

export function earlierRoundsOf(question: AgentQuestion): QuestionStep[] {
  return question.steps ? question.steps.slice(0, -1) : [];
}

export function roundCountOf(question: AgentQuestion): number {
  return question.steps?.length ?? question.rounds ?? (question.currentStep ? 1 : 0);
}

export type GivenAnswer = { optionId: string; text?: never } | { text: string; optionId?: never };

/** The answer does not release its issue: what it still waits on, and the issue key that blocks it. */
export interface StillWaits {
  reason: string;
  blockedBy?: string;
}

export type AnswerInput = GivenAnswer & {
  questionId: string;
  round: number;
  note?: string;
  stillWaits?: StillWaits;
};
