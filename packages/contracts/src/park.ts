import type { KernelIssueStatus } from "./issue-vocabulary.js";

export type ParkOwes = "information" | "decision" | "resource";

/** Read off `issue_work_state.left_status` — the status the park left — never guessed. */
export type ParkResume =
  | { at: KernelIssueStatus; recordId: string | null }
  | { at: null; why: string };

export interface ParkRecordView {
  /** The comment that carried the record, or null where it was written only as an event (ISS-56). */
  commentId: string | null;
  /** The record event it is stored as, or null for a record posted before events existed. */
  eventId: string | null;
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
  /** `park` at `needs_info`; `question` at a working status holding an open human question. */
  shape: "park" | "question";
  status: KernelIssueStatus;
  owes: ParkOwes;
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
