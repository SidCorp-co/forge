"use client";

// Text a person or a model wrote, shown as it was written: never translated, marked with the
// language it was written in where that is not the reader's, so a vi reader meeting an English
// sentence reads it as someone's English rather than as a gap in the interface. Null is a text
// whose language was not kept (written before it was), and carries no mark: a guess would be one.

import type { WrittenLang } from "@forge/contracts/written-lang";
import { useCopy, useInterfaceLanguage } from "./interface-language";
import { baseOf } from "./product-copy";

/** Whether a text written in `lang` reads as foreign to a reader of `reader`: known, and not theirs. */
export const writtenElsewhere = (lang: WrittenLang | null | undefined, reader: string): lang is WrittenLang => !!lang && lang !== baseOf(reader);

/** The mark a written text carries where its language is not the reader's; nothing otherwise. */
export function WrittenMark({ lang }: { lang: WrittenLang | null | undefined }) {
  const t = useCopy();
  const reader = useInterfaceLanguage();
  if (!writtenElsewhere(lang, reader)) return null;
  return (
    <span className="ml-1.5 align-middle font-mono text-11 uppercase text-muted" title={t("written.in", { language: t(`written.lang.${lang}`) })} data-testid="written-mark">
      {lang}
    </span>
  );
}

/** A written text with its `lang` attribute and, where it is not the reader's, its mark. */
export function Written({ text, lang, className }: { text: string; lang: WrittenLang | null | undefined; className?: string }) {
  return (
    <span className={className} lang={lang ?? undefined}>
      {text}
      <WrittenMark lang={lang} />
    </span>
  );
}
