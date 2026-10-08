// a record page (an issue, a requirement, a feedback item, a workflow) needs no words in the draft: the
// page's snapshot names it and core loads it for the turn (REQ-30 BC-6). A run and a document are not
// such a record, so their key is put in front of the assistant as the first words of the message the
// person sends, which they can read and change
export const ABOUT_KINDS = ["run", "document"] as const;
export type AboutKind = (typeof ABOUT_KINDS)[number];

/** What Ask about this is about: an object named in the draft, or `null` for the page's own record. */
export type AskAbout = { kind: AboutKind; ref: string } | null;

export function aboutDraft(about: AskAbout): string | undefined {
  if (!about) return undefined;
  const r = about.ref.trim();
  if (!r || !(ABOUT_KINDS as readonly string[]).includes(about.kind)) return undefined;
  return `About ${about.kind} ${r}: `;
}
