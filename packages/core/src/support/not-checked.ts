// A reply saying plainly it has not checked a state now (ISS-1430, L-167): "I have not checked whether
// it is deployed", "I can't say if the flag is on". What it frames as unchecked is no claim of the
// state, so neither the pre-post screen (`live-claims.ts:liveClaimIn`) nor the reply audit
// (`reply-audit/code-lines.ts:assertedStateClaimIn`) reads it as one; a value restated beside it is.

/** A letter boundary: `\b` is ASCII-only, and Vietnamese words end in letters it does not know. */
const START = '(?<![\\p{L}\\p{N}_])';

/** The forms a plain "not checked now" takes, in English and Vietnamese. */
const NOT_CHECKED: readonly RegExp[] = [
  /\b(?:I|we)\s+(?:have\s+not|haven['’]t|did\s+not|didn['’]t|could\s+not|couldn['’]t|cannot|can['’]t|can\s+not)\s+(?:yet\s+)?(?:checked|check|read|re-?read|verified|verify|confirmed|confirm|looked|look|say|tell)\b/i,
  /\b(?:has|have)\s+not\s+been\s+(?:checked|read|verified|confirmed)\b|\bnot\s+(?:yet\s+)?(?:checked|re-?read|verified)\s+(?:now|this\s+turn|yet)\b/i,
  new RegExp(
    `${START}(?:chưa|không)\\s+(?:thể\\s+|kịp\\s+)?(?:kiểm\\s+tra|đọc|xem|xác\\s+minh|check|nói|biết)(?![\\p{L}\\p{N}_])`, // i18n-allow: the Vietnamese "not checked" being recorded
    'iu',
  ),
];
/** The words that turn what follows into a question: "whether", "if", and their Vietnamese twins. */
const ASKED_BEFORE = /(?<![\p{L}\p{N}_])(?:whether|if|liệu|xem)(?![\p{L}\p{N}_])/iu; // i18n-allow: the Vietnamese question words
/** The tag that leaves a state open after it: "or not", and its Vietnamese forms. */
const ASKED_AFTER = /^\s*(?:or\s+not|hay\s+(?:chưa|không))(?![\p{L}\p{N}_])/iu; // i18n-allow: the Vietnamese question tags
/** Where a clause ends: a sentence's end (never a version's dot), a semicolon, a line, or "but". */
const CLAUSE_END =
  /(?<!\d)[.!?…](?!\d)|[;\n]|,\s*(?=(?:but|nhưng|tuy\s+nhiên)(?![\p{L}\p{N}_]))/giu; // i18n-allow: the Vietnamese "but"

/** The clause of `text` around `[from, to)`. */
function clauseAround(text: string, from: number, to: number): { start: number; text: string } {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(CLAUSE_END)) {
    if (m.index + m[0].length <= from) start = m.index + m[0].length;
    else if (m.index >= to) {
      end = m.index;
      break;
    }
  }
  return { start, text: text.slice(start, end) };
}

/**
 * Whether the state found at `[from, to)` is only asked about, under a plain "not checked now" in its
 * clause: a question word between that line and it ("I have not checked whether it is on"), or an
 * "or not" after it ("…is it on or not").
 */
function askedNotClaimed(text: string, from: number, to: number): boolean {
  const clause = clauseAround(text, from, to);
  const at = from - clause.start;
  const notChecked = NOT_CHECKED.map((form) => form.exec(clause.text)).find((m) => m !== null);
  if (!notChecked) return false;
  if (ASKED_AFTER.test(text.slice(to))) return true;
  const said = notChecked.index + notChecked[0].length;
  const before = said <= at ? clause.text.slice(said, at) : clause.text.slice(0, at);
  return ASKED_BEFORE.test(before);
}

/**
 * The words of the first match of `forms`, in their order, that `text` asserts: one only asked
 * about under a plain "not checked now" is skipped. Null where it asserts none.
 */
export function firstAssertedIn(text: string, forms: readonly RegExp[]): string | null {
  for (const form of forms) {
    const every = new RegExp(form.source, form.flags.includes('g') ? form.flags : `${form.flags}g`);
    for (const found of text.matchAll(every)) {
      if (!askedNotClaimed(text, found.index, found.index + found[0].length)) {
        return found[0].trim();
      }
    }
  }
  return null;
}
