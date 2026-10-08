/**
 * What code may do to a model's reply without changing what it claims: point an issue link the web
 * cannot open at the one it can, and mark a claim it could not check as unverified. A marked claim
 * is no longer asserted, so the rules that judge assertions read past it (`progress-rule.ts`,
 * `figures-rule.ts`; the hedge words in the mark are what `grounding-rule.ts` and
 * `status-assertions.ts` already abstain on). A claim to have written a record is not one of them:
 * it is about the turn, true or false however it is marked (`creation-claims-rule.ts`).
 */

/** The mark set after a claim the reply screen could not check, in the asker's language. */
export const UNVERIFIED_MARK = {
  en: '(unverified, this may be wrong)',
  vi: '(chưa kiểm chứng, có thể sai)', // i18n-allow: the mark a Vietnamese asker reads beside an unchecked claim
} as const;

type MarkLanguage = keyof typeof UNVERIFIED_MARK;

/** Either language's mark, spelled once above. */
const MARK_RE = new RegExp(
  Object.values(UNVERIFIED_MARK)
    .map((m) => m.replace(/[()]/g, '\\$&'))
    .join('|'),
  'g',
);

/** Where a clause ends: the punctuation every rule splits on, a stop or colon only before a space. */
const CLAUSE_END_RE = /[;!?\n]|[.:](?=\s|$)/;

/** An issue link written as a hash route, `#/projects/<slug>/issues/<uuid>`, which the web does not serve. */
const HASH_ISSUE_LINK_RE =
  /(?<![^\s([<"'`*_])#(\/projects\/[\w-]+\/issues\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![\w-])/gi;

/** The reply with every hash-routed issue link pointed at the path the web serves; nothing else moves. */
export function repairIssueLinks(text: string): string {
  return text.replace(HASH_ISSUE_LINK_RE, '$1');
}

/** Where the clause holding `at` ends: before its closing punctuation, or at the end of the text. */
function clauseEnd(text: string, at: number): number {
  const rest = text.slice(at);
  const m = CLAUSE_END_RE.exec(rest);
  if (!m) return text.length;
  let end = at + m.index;
  while (end > at && /[\s*_`~]/.test(text[end - 1] as string)) end -= 1;
  return end;
}

/**
 * The reply with the mark set at the end of each clause holding one of `quotes`, or null where a
 * quote is not in the reply: a claim that cannot be found cannot be marked.
 */
export function markUnverified(
  text: string,
  quotes: readonly string[],
  language: MarkLanguage,
): string | null {
  const ends = new Set<number>();
  for (const quote of quotes) {
    const at = text.indexOf(quote);
    if (at < 0) return null;
    ends.add(clauseEnd(text, at + quote.length));
  }
  let out = text;
  for (const end of [...ends].sort((a, b) => b - a)) {
    out = `${out.slice(0, end)} ${UNVERIFIED_MARK[language]}${out.slice(end)}`;
  }
  return out;
}

/** The text with every marked clause blanked in place, so offsets into it still point into the reply. */
export function blankMarkedClauses(text: string): string {
  let out = text;
  for (const m of text.matchAll(MARK_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    let start = m.index ?? 0;
    while (start > 0 && !CLAUSE_END_RE.test(text.slice(start - 1, start + 1))) start -= 1;
    out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`;
  }
  return out;
}
