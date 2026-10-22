/**
 * What code may do to a model's reply without changing what it claims: point an issue link the web
 * cannot open at the one it can, and cut the sentence, list item or heading holding a claim the reply
 * screen could not check (REQ-41 BC-3: a held reply keeps whole sentences and the part it could
 * check). A mark left by an earlier build, set after a claim it could not check, is read past by the
 * rules that judge assertions (`progress-rule.ts`, `figures-rule.ts`): a stored reply still carries it.
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
const CLAUSE_END = /[;!?\n]/;
const SPACED_END = /[.:]/;

/** Whether `text[i]` ends a clause: a stop or colon counts only where a space or the text's end follows. */
function endsClause(text: string, i: number): boolean {
  const c = text.charAt(i);
  if (CLAUSE_END.test(c)) return true;
  return SPACED_END.test(c) && (i + 1 === text.length || /\s/.test(text.charAt(i + 1)));
}

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
  while (start > 0 && !endsClause(text, start - 1)) start -= 1;
  return start;
}

/** A line that is one unit whole: a list item, a heading or a table row. */
const ITEM_LINE = /^(\s*)(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/;
const HEADING_LINE = /^\s*#{1,6}\s/;
/** What may close a sentence after its stop: emphasis, code, a bracket or a quote mark. */
const CLOSERS = /[*_`)\]"”’]/;

interface Span {
  start: number;
  stop: number;
  /** The remainder begins a sentence and its first letter is raised. */
  raise?: boolean;
}

/** The line holding `at`, its newline included. */
function lineAt(text: string, at: number): Span {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  return { start, stop: nl < 0 ? text.length : nl + 1 };
}

const indentOf = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;

/** A list item with every line nested under it, a heading, or a table row: the line and its children. */
function itemAt(text: string, line: Span): Span {
  const own = text.slice(line.start, line.stop);
  if (HEADING_LINE.test(own) || own.trimStart().startsWith('|')) return line;
  const depth = indentOf(own);
  let stop = line.stop;
  while (stop < text.length) {
    const next = lineAt(text, stop);
    const body = text.slice(next.start, next.stop);
    if (!body.trim() || indentOf(body) <= depth) break;
    stop = next.stop;
  }
  return { start: line.start, stop };
}

/** Where a sentence stops at `i`: its stop, then any closing marks, before a space or the line's end. */
function sentenceStopAt(text: string, i: number, lineStop: number): number | null {
  if (!/[.!?…]/.test(text.charAt(i))) return null;
  let j = i + 1;
  while (j < lineStop && CLOSERS.test(text.charAt(j))) j += 1;
  return j === lineStop || /\s/.test(text.charAt(j)) ? j : null;
}

/** The sentence holding `at`..`end` inside its line, with the space after it. */
function sentenceAt(text: string, at: number, end: number, line: Span): Span {
  let start = line.start;
  for (let i = at - 1; i >= line.start; i -= 1) {
    const stop = sentenceStopAt(text, i, line.stop);
    if (stop !== null && stop <= at) {
      start = stop;
      break;
    }
  }
  let stop = line.stop;
  for (let i = end; i < line.stop; i += 1) {
    const found = sentenceStopAt(text, i, line.stop);
    if (found !== null) {
      stop = found;
      break;
    }
  }
  while (start < at && /[ \t]/.test(text.charAt(start))) start += 1;
  while (stop < line.stop && /[ \t]/.test(text.charAt(stop))) stop += 1;
  return partOf(text, { start, stop }, at, end);
}

/** A joint between two statements of one sentence: ", and", ", but", ", while", ", whereas", ", yet" or ";". */
const JOINT_RE = /(?:,\s+(?:and|but|while|whereas|yet)|;)\s+/giu;
const MIN_PART_WORDS = 3;
const wordsIn = (text: string): number => (text.match(/\S+/g) ?? []).length;

/**
 * The one statement of `sentence` holding the claim, where the sentence joins statements that each
 * stand alone (a few words either side of the joint), else the whole sentence: one unbacked key does
 * not take the backed statement it is joined to (QA of dev.219, ISS-495).
 */
function partOf(text: string, sentence: Span, at: number, end: number): Span {
  const whole = text.slice(sentence.start, sentence.stop).trimEnd();
  const closing = /[.!?…]$/.exec(whole)?.[0] ?? '';
  const bodyEnd = sentence.start + whole.length - closing.length;
  const joints = [...text.slice(sentence.start, bodyEnd).matchAll(JOINT_RE)].map((m) => ({
    from: sentence.start + (m.index ?? 0),
    to: sentence.start + (m.index ?? 0) + m[0].length,
  }));
  const before = joints.filter((j) => j.to <= at).at(-1);
  const after = joints.find((j) => j.from >= end);
  const from = before ? before.to : sentence.start;
  const to = after ? after.from : bodyEnd;
  const rest = wordsIn(text.slice(sentence.start, from)) + wordsIn(text.slice(to, bodyEnd));
  if (
    joints.length === 0 ||
    wordsIn(text.slice(from, to)) < MIN_PART_WORDS ||
    rest < MIN_PART_WORDS
  ) {
    return sentence;
  }
  if (after) {
    return before
      ? { start: before.from, stop: after.from }
      : { start: sentence.start, stop: after.to, raise: true };
  }
  return { start: (before as { from: number }).from, stop: bodyEnd };
}

/** Whether what a line keeps is no statement: no word, or a bold or code span left open. */
function brokenRest(rest: string): boolean {
  const body = rest.replace(ITEM_LINE, '').trim();
  if (!/[\p{L}\p{N}]/u.test(body)) return true;
  const bold = (body.match(/\*\*/g) ?? []).length;
  const code = (body.match(/`/g) ?? []).length;
  return bold % 2 === 1 || code % 2 === 1;
}

function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && s.start <= last.stop) {
      if (s.stop > last.stop) last.raise = s.raise;
      last.stop = Math.max(last.stop, s.stop);
    } else out.push({ ...s });
  }
  return out;
}

const without = (text: string, spans: readonly Span[]): string => {
  let out = '';
  let from = 0;
  for (const s of spans) {
    out += text.slice(from, s.start);
    from = s.stop;
    if (s.raise) {
      const letter = /\p{L}/u.exec(text.slice(from));
      if (letter) {
        const i = from + letter.index;
        out += text.slice(from, i) + text.charAt(i).toUpperCase();
        from = i + 1;
      }
    }
  }
  return out + text.slice(from);
};

/** A heading with nothing left under it before the next heading or the end goes too. */
function withoutBareHeadings(text: string): string {
  const lines = text.split('\n');
  return lines
    .filter((line, i) => {
      if (!HEADING_LINE.test(line)) return true;
      const next = lines.slice(i + 1).find((l) => l.trim() !== '');
      return next !== undefined && !HEADING_LINE.test(next);
    })
    .join('\n');
}

/**
 * The reply with each sentence, list item (and the items nested under it) or heading holding one of
 * `quotes` cut whole, or null where a quote is not in the reply: a claim that cannot be found cannot
 * be cut. Where cutting a sentence would leave its line with no word or with a bold or code span
 * open, the line goes. What is left is tidied (a heading left with nothing under it goes, runs of
 * blank lines close up) and never blanked: a cut timestamp, a label without its claim or a clause
 * without its verb is never left (REQ-41 BC-3).
 */
export function cutHeldSentences(text: string, quotes: readonly string[]): string | null {
  const spans: Span[] = [];
  for (const quote of quotes) {
    const at = text.indexOf(quote);
    if (at < 0) return null;
    const line = lineAt(text, at);
    const own = text.slice(line.start, line.stop);
    spans.push(
      ITEM_LINE.test(own) ? itemAt(text, line) : sentenceAt(text, at, at + quote.length, line),
    );
  }
  let cuts = merged(spans);
  const lines = new Map<number, Span>();
  for (const s of cuts) {
    const line = lineAt(text, s.start);
    lines.set(line.start, line);
  }
  const widened = [...lines.values()].filter((line) => {
    const inLine = cuts
      .filter((s) => s.start < line.stop && s.stop > line.start)
      .map((s) => ({ start: Math.max(s.start, line.start), stop: Math.min(s.stop, line.stop) }))
      .map((s) => ({ start: s.start - line.start, stop: s.stop - line.start }));
    return brokenRest(without(text.slice(line.start, line.stop), inLine));
  });
  cuts = merged([...cuts, ...widened]);
  return withoutBareHeadings(without(text, cuts))
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
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
