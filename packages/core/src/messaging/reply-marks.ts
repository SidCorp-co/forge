/**
 * What code may do to a model's reply without changing what it claims: point an issue link the web
 * cannot open at the one it can, and cut a clause holding a claim the reply screen could not check
 * (REQ-41 BC-3: a held reply shows the part it could check). A mark left by an earlier build, set
 * after a claim it could not check, is read past by the rules that judge assertions
 * (`progress-rule.ts`, `figures-rule.ts`): a stored reply still carries it.
 */

/** The mark an earlier build set after a claim the reply screen could not check, in the asker's language. */
export const UNVERIFIED_MARK = {
  en: '(unverified, this may be wrong)',
  vi: '(chưa kiểm chứng, có thể sai)', // i18n-allow: the mark a Vietnamese asker reads beside an unchecked claim
} as const;

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

/** Where the clause holding `at` starts: just after the clause end before it, or at the start. */
function clauseStart(text: string, at: number): number {
  let start = at;
  while (start > 0 && !CLAUSE_END_RE.test(text.slice(start - 1, start + 1))) start -= 1;
  return start;
}

/** Where the clause holding `at` ends, its closing punctuation included. */
function clauseStop(text: string, at: number): number {
  const m = CLAUSE_END_RE.exec(text.slice(at));
  return m ? at + m.index + m[0].length : text.length;
}

/**
 * The reply with each clause holding one of `quotes` cut whole, by the clause rule the marks read
 * by, or null where a quote is not in the reply: a claim that cannot be found cannot be cut. What is
 * left is tidied (a list line left empty goes, runs of blank lines close up) and never blanked.
 */
export function cutClauses(text: string, quotes: readonly string[]): string | null {
  const spans: [number, number][] = [];
  for (const quote of quotes) {
    const at = text.indexOf(quote);
    if (at < 0) return null;
    spans.push([clauseStart(text, at), clauseStop(text, at + quote.length)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  for (const [start, stop] of spans) {
    if (stop <= from) continue;
    out += text.slice(from, Math.max(from, start));
    from = stop;
  }
  out += text.slice(from);
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .filter((line) => !/^\s*(?:[-*+]|\d+[.)])?\s*$/.test(line) || line === '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text with every marked clause blanked in place, so offsets into it still point into the reply. */
export function blankMarkedClauses(text: string): string {
  let out = text;
  for (const m of text.matchAll(MARK_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    const start = clauseStart(text, m.index ?? 0);
    out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`;
  }
  return out;
}
