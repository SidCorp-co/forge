// What a person typed into a move's checklist form, kept per issue and move for as long as this tab
// lives: across a second refusal, a close, and the screen that opened the form going away. It is
// sent with that issue's next move and forgotten only when the move passes, so an answer the person
// gave is recorded as given, never replaced by the assumed one (REQ-34 BC-26).

const drafts = new Map<string, Record<string, string>>();

const keyOf = (issueId: string, toStatus: string) => `${issueId}>${toStatus}`;

export function checklistDraft(issueId: string, toStatus: string): Record<string, string> {
  return { ...(drafts.get(keyOf(issueId, toStatus)) ?? {}) };
}

export function keepChecklistDraft(issueId: string, toStatus: string, typed: Record<string, string>): void {
  drafts.set(keyOf(issueId, toStatus), { ...typed });
}

export function forgetChecklistDraft(issueId: string, toStatus: string): void {
  drafts.delete(keyOf(issueId, toStatus));
}
