// Text a person or a model wrote, shown as it was written: never translated and never marked with a
// language. The chrome is English only (owner, 2026-10-08), so a language badge is chrome too, and a
// Vietnamese sentence is content that stands as written (ISS-1071). The `lang` attribute stays for the
// browser and assistive tech; null is a text whose language was not kept, and guesses none.

import type { WrittenLang } from "@forge/contracts/written-lang";

/** A written text with its `lang` attribute; nothing where none was written. */
export function Written({ text, lang, className }: { text: string | null; lang: WrittenLang | null | undefined; className?: string }) {
  if (text === null) return null;
  return (
    <span className={className} lang={lang ?? undefined}>
      {text}
    </span>
  );
}
