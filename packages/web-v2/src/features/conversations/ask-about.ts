import { chatPath } from "@/features/shell/mode";

export const ABOUT_KINDS = ["issue", "run", "document"] as const;
export type AboutKind = (typeof ABOUT_KINDS)[number];

export function chatAbout(slug: string, kind: AboutKind, ref: string): string {
  return `${chatPath(slug)}?${new URLSearchParams({ about: `${kind}:${ref}` })}`;
}

// cm:why the object is put in front of the assistant as the first words of the message the person sends, which they can read and change, rather than as a hidden context field no server reads
export function aboutDraft(about: string | null): string | undefined {
  if (!about) return undefined;
  const at = about.indexOf(":");
  const kind = about.slice(0, at);
  const ref = about.slice(at + 1).trim();
  if (at < 1 || !ref || !(ABOUT_KINDS as readonly string[]).includes(kind)) return undefined;
  return `About ${kind} ${ref}: `;
}
