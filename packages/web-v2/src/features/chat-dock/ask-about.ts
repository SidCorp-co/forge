export const ABOUT_KINDS = ["issue", "run", "document"] as const;
export type AboutKind = (typeof ABOUT_KINDS)[number];

// the object is put in front of the assistant as the first words of the message the person sends, which they can read and change, rather than as a hidden context field no server reads
export function aboutDraft(kind: AboutKind, ref: string): string | undefined {
  const r = ref.trim();
  if (!r || !(ABOUT_KINDS as readonly string[]).includes(kind)) return undefined;
  return `About ${kind} ${r}: `;
}
