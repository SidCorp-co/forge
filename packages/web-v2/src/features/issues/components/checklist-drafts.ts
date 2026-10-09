// What a person typed into a move's checklist form, kept for as long as this tab lives: across a
// second refusal, a close, and the screen that opened the form going away. It is sent with that
// issue's next move, so an answer the person gave is recorded as given, never replaced by the
// assumed one (REQ-34 BC-26).
//
// A kept answer belongs to one move: the issue, the status it stood at when the form opened, and
// the status it was moving to. It goes out only with that same move, and only where the issue
// machine's edge for it asks a checklist; once the issue has moved any other way the move it was
// typed for is gone, and so is the answer, so a stale answer never reaches a move that takes none.

import { isChecklistId } from "@forge/contracts/checklist-registry";
import { ISSUE_MACHINE } from "@forge/contracts/issue-machine";
import { edgeBetween } from "@forge/contracts/state-machine";
import type { IssueStatus } from "../types";

interface Kept {
  from: IssueStatus;
  to: IssueStatus;
  typed: Record<string, string>;
}

const kept = new Map<string, Kept>();

/** The checklist the issue machine's edge `from → to` asks, or null where the move asks none. */
export function checklistOfMove(from: IssueStatus, to: IssueStatus): string | null {
  const id = edgeBetween(ISSUE_MACHINE, from, to)?.checklist;
  return id !== undefined && isChecklistId(id) ? id : null;
}

/** What was typed for this move of this issue; nothing where it was typed for another. */
export function checklistDraft(issueId: string, from: IssueStatus, to: IssueStatus): Record<string, string> {
  const k = kept.get(issueId);
  return k && k.from === from && k.to === to ? { ...k.typed } : {};
}

export function keepChecklistDraft(issueId: string, from: IssueStatus, to: IssueStatus, typed: Record<string, string>): void {
  kept.set(issueId, { from, to, typed: { ...typed } });
}

/** Forgets what was typed for any move of the issue: it moved, or the answers have nowhere to go. */
export function forgetChecklistDrafts(issueId: string): void {
  kept.delete(issueId);
}

/**
 * What goes with a move of the issue from the status it stands at now: the answers typed for that
 * move where its edge asks a checklist, else nothing. An answer typed while the issue stood at
 * another status is forgotten here, since the issue has moved since.
 */
export function answersForMove(issueId: string, from: IssueStatus, to: IssueStatus): Record<string, string> {
  const k = kept.get(issueId);
  if (!k) return {};
  if (k.from !== from) {
    kept.delete(issueId);
    return {};
  }
  return k.to === to && checklistOfMove(from, to) !== null ? { ...k.typed } : {};
}
