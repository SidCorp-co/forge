// The query's expansion through the glossary (ISS-1256): a term's aliases (Vietnamese, code and
// industry names) match the term, so "chia slot" finds Run slots though neither its title nor its
// text says it. Pure: the terms are read by `model-reads.ts:glossaryTerms`.

import type { FindExpansion } from '@forge/contracts/find';
import type { GlossaryTerm } from './model-reads.js';

/** Lower case, accents and the Vietnamese d-with-stroke folded, every run of non-letters one space. */
export function normalized(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/\u0111/gi, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The shortest query an alias is read as holding, so "a" names no term. */
const MIN_HELD_QUERY = 3;

/** Whether `phrase` stands in `text` as whole words. */
const holds = (text: string, phrase: string) =>
  phrase !== '' && ` ${text} `.includes(` ${phrase} `);

/**
 * The terms the query names by an alias or by their own title, each once, with the alias it matched:
 * a query holding an alias, or an alias holding the whole query, names the term.
 */
export function expandThroughGlossary(
  query: string,
  terms: readonly GlossaryTerm[],
): { term: GlossaryTerm; expansion: FindExpansion }[] {
  const q = normalized(query);
  if (!q) return [];
  const out: { term: GlossaryTerm; expansion: FindExpansion }[] = [];
  for (const term of terms) {
    const alias = term.aliases.find((a) => {
      const n = normalized(a);
      return holds(q, n) || (q.length >= MIN_HELD_QUERY && holds(n, q));
    });
    if (alias) out.push({ term, expansion: { term: term.title, alias, termId: term.id } });
  }
  return out;
}

/** The text every keyword arm searches: the query, and the title of each term an alias named. */
export function expandedText(query: string, named: readonly { term: GlossaryTerm }[]): string {
  return [query.trim(), ...named.map((n) => n.term.title)].join(' ');
}

/** The phrases a substring arm matches: the query and each named term's title. */
export function expandedPhrases(query: string, named: readonly { term: GlossaryTerm }[]): string[] {
  return [...new Set([query.trim(), ...named.map((n) => n.term.title)])].filter(Boolean);
}
