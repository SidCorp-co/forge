/**
 * A needs-you row's title, as the one thing a reader reads it as: a writer's own words, kept with the
 * language they were written in and shown as written, or Forge's own words, said by key so a vi
 * reader reads them in vi. Never the one passed off as the other.
 */

import { type Said, sayEn, verbatim } from '@forge/contracts/said';
import type { WrittenLang } from '@forge/contracts/written-lang';

export interface RowTitle {
  /** The title in English where Forge composed it, else the writer's words as written. */
  title: string;
  /** The language the writer wrote in; null when Forge composed it or the language was not kept. */
  titleLang: WrittenLang | null;
  /** `title` as said: verbatim for a writer's words, by key for Forge's own. */
  says: { title: Said };
}

/** A title a person or a model wrote: shown as written, in the language it was written in. */
export const writtenTitle = (title: string, lang: WrittenLang | null): RowTitle => ({
  title,
  titleLang: lang,
  says: { title: verbatim(title) },
});

/** A title Forge composes where nobody wrote one. */
export const composedTitle = (s: Said): RowTitle => ({
  title: sayEn(s),
  titleLang: null,
  says: { title: s },
});
