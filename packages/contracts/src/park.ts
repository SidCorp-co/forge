import type { KernelIssueStatus } from "./issue-vocabulary.js";

export type ParkOwes = "information" | "decision" | "resource";

/** Read off the park record's `left` stamp alone — never the history, never a default. */
export type ParkResume =
  | { at: KernelIssueStatus; recordId: string }
  | { at: null; why: string };

export interface ParkRecordView {
  commentId: string;
  kind: string | null;
  why: string | null;
  postedAt: string;
}

export interface ParkAnswerView {
  commentId: string;
  postedAt: string;
  text: string;
}

export interface IssuePark {
  /** `park` at `needs_info` or `waiting`; `question` at a working rung holding an open human question. */
  shape: "park" | "question";
  status: KernelIssueStatus;
  /** `null` only for a `waiting` park that stored no kind. */
  owes: ParkOwes | null;
  since: string | null;
  reason: string | null;
  resume: ParkResume;
  record: ParkRecordView | null;
  readings: string[];
  /** `null` until a person replies after the park record, and always where there is no record. */
  answer: ParkAnswerView | null;
  openQuestionIds: string[];
}

export interface IssueParkResponse {
  park: IssuePark | null;
}
