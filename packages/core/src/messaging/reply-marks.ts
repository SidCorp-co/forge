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

/** A coordinating joint inside one clause: the part either side of it can stand as a statement of its own. */
const JOINT_RE = /,\s+(?:and|but|while|whereas|yet)\s+/giu;

/** Words a part holds; a part too short to be a statement is not cut on its own. */
const wordsIn = (text: string): number => (text.match(/\S+/g) ?? []).length;
const MIN_PART_WORDS = 3;

/** A span of the reply to drop, and what stays in its place (the closing mark of a clause whose last part went). */
interface Cut {
  start: number;
  stop: number;
  keep: string;
  /** The remainder begins a sentence and its first letter is raised. */
  raise: boolean;
}

/**
 * What to drop for the claim at `at`..`end`: the one part of its clause that holds it where the
 * clause joins two statements (", and ", ", but "), each of at least a few words, else the whole
 * clause. A label ("ISS-9998: not found") carries its claim after the colon, so the clause runs on
 * to its real end. The reply is screened again after the cut, so what a part leaves is judged as
 * the statement it now is.
 */
function cutOf(text: string, at: number, end: number): Cut {
  const start = clauseStart(text, at);
  let stop = clauseStop(text, end);
  if (text.slice(end, stop).trim() === ':') stop = clauseStop(text, stop);
  const clause = text.slice(start, stop);
  const closing = /[.!?]$/.exec(clause)?.[0] ?? '';
  const body = closing ? clause.slice(0, -1) : clause;
  const joints = [...body.matchAll(JOINT_RE)].map((m) => ({
    from: start + (m.index ?? 0),
    to: start + (m.index ?? 0) + m[0].length,
  }));
  const before = joints.filter((j) => j.to <= at).at(-1);
  const after = joints.find((j) => j.from >= end);
  const partFrom = before ? before.to : start;
  const partTo = after ? after.from : start + body.length;
  const standAlone =
    joints.length > 0 &&
    wordsIn(text.slice(partFrom, partTo)) >= MIN_PART_WORDS &&
    wordsIn(text.slice(start, partFrom)) + wordsIn(text.slice(partTo, start + body.length)) >=
      MIN_PART_WORDS;
  if (!standAlone) return { start, stop, keep: '', raise: false };
  if (after) {
    return before
      ? { start: before.from, stop: after.from, keep: '', raise: false }
      : { start, stop: after.to, keep: '', raise: true };
  }
  return { start: before ? before.from : start, stop, keep: closing, raise: false };
}

/**
 * The reply with each clause holding one of `quotes` cut, by the clause rule the marks read by, or
 * null where a quote is not in the reply: a claim that cannot be found cannot be cut. Where a clause
 * joins two statements, only the one holding the claim goes (`cutOf`). What is left is tidied (a list
 * line left empty goes, runs of blank lines close up) and never blanked.
 */
export function cutClauses(text: string, quotes: readonly string[]): string | null {
  const spans: Cut[] = [];
  for (const quote of quotes) {
    const at = text.indexOf(quote);
    if (at < 0) return null;
    spans.push(cutOf(text, at, at + quote.length));
  }
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let from = 0;
  const raised: number[] = [];
  for (const span of spans) {
    if (span.stop <= from) continue;
    out += text.slice(from, Math.max(from, span.start)) + span.keep;
    from = span.stop;
    if (span.raise) raised.push(out.length);
  }
  out += text.slice(from);
  for (const at of raised) {
    const letter = /\p{L}/u.exec(out.slice(at));
    if (letter) {
      const i = at + letter.index;
      out = out.slice(0, i) + out.charAt(i).toUpperCase() + out.slice(i + 1);
    }
  }
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
