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

/** One round of one decision. A follow-up is another step on the same row, never a second row. */
export interface QuestionStep {
  round: number;
  prompt: string;
  options: QuestionOption[];
  recommendedOptionId: string;
  askedAt: string;
  answeredAt?: string;
  chosenOptionId?: string;
  answeredBy?: string;
}

export interface AgentQuestion {
  id: string;
  projectId: string;
  issueId: string | null;
  status: QuestionStatus;
  blockerKind: BlockerKind;
  steps: QuestionStep[];
  maxRounds: number;
  voidReason: string | null;
  endedReason: string | null;
  parkDeadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The CURRENT round's options, each with the server's `locked` verdict. */
  options: VisibleOption[];
  recommendedOptionId: string;
}

export interface QuestionListResponse {
  questions: AgentQuestion[];
}

export interface AnswerInput {
  questionId: string;
  optionId: string;
  /** The round the person was looking at. Core refuses an answer bound to any other. */
  round: number;
}
