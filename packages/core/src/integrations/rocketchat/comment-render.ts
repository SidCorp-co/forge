export function threadRootText(issueKey: string, title: string): string {
  return `**${issueKey} — ${title}**\nComments on this issue appear in this thread, and a reply here becomes a comment on it.`;
}
