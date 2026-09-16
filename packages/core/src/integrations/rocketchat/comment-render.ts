// The text a mirrored comment puts in a room.
//
// Separate from the delivery for the same reason `question-render.ts` is: this
// is pure string work, so it is unit-testable without booting env or a db.

/** The root that opens an issue's thread, naming what the thread is about. */
export function threadRootText(issueKey: string, title: string): string {
  return `**${issueKey} — ${title}**\nComments on this issue appear in this thread, and a reply here becomes a comment on it.`;
}
