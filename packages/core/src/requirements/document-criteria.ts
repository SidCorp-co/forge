/**
 * A requirement's criteria taken from a document's own lines, never retyped by a model: each list
 * item is one criterion, its text exactly as the document has it. A line that cannot be a criterion
 * as it stands is refused by its line number rather than dropped, merged or reworded — a draft that
 * silently lost line 57 of a 120-line list reads as complete and is not.
 */

import { FILTERED } from '@forge/observability';

/** The most criteria a revision holds and the longest a criterion's body may be (`requirementCriterionSchema`). */
export const DOCUMENT_CRITERIA_MAX = 200;
export const DOCUMENT_CRITERION_BODY_MAX = 10_000;

export type DocumentCriteria =
  | {
      ok: true;
      criteria: { body: string; line: number }[];
    }
  | { ok: false; line: number | null; detail: string };

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)(?:[-*+•▪◦‣]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*?)\s*$/;

const excerpt = (line: string) => (line.length > 80 ? `${line.trim().slice(0, 77)}…` : line.trim());

interface Region {
  first: number;
  last: number;
}

function sectionRegion(lines: readonly string[], file: string, section: string): Region | string {
  const wanted = section
    .trim()
    .replace(/^#+\s*/, '')
    .toLowerCase();
  const headings: { at: number; level: number; text: string }[] = [];
  lines.forEach((line, at) => {
    const m = HEADING.exec(line);
    if (m?.[1] && m[2] !== undefined) headings.push({ at, level: m[1].length, text: m[2] });
  });
  const start = headings.find((h) => h.text.toLowerCase() === wanted);
  if (!start) {
    const named = headings.map((h) => `"${h.text}"`).slice(0, 20);
    return named.length === 0
      ? `${file} has no headings, so there is no section "${section}" in it — leave section out to take the whole file`
      : `${file} has no heading "${section}"; its headings are ${named.join(', ')}`;
  }
  const end = headings.find((h) => h.at > start.at && h.level <= start.level);
  return { first: start.at + 1, last: (end?.at ?? lines.length) - 1 };
}

/**
 * The criteria `text` holds: every list item of the named section (every list item of the file
 * where none is named), in order. Blank lines, headings and rules are the document's structure and
 * are skipped; any other line is refused by number, as is a nested item, an item longer than a
 * criterion may be, an item the scrubber redacted, and the item past the most a revision holds.
 */
export function criteriaFromDocument(
  text: string,
  opts: { file: string; section?: string | undefined },
): DocumentCriteria {
  const lines = text.split(/\r?\n/);
  const region = opts.section
    ? sectionRegion(lines, opts.file, opts.section)
    : { first: 0, last: lines.length - 1 };
  if (typeof region === 'string') return { ok: false, line: null, detail: region };
  const criteria: { body: string; line: number }[] = [];
  for (let at = region.first; at <= region.last; at++) {
    const raw = lines[at] ?? '';
    const n = at + 1;
    if (raw.trim() === '' || HEADING.test(raw) || RULE.test(raw)) continue;
    const item = ITEM.exec(raw);
    const where = `line ${n} of ${opts.file} ("${excerpt(raw)}")`;
    if (!item) {
      return {
        ok: false,
        line: n,
        detail: `${where} is not a list item, and each criterion is one list line — make it one, join it to the item it continues, or name the section that holds only the criteria`,
      };
    }
    if ((item[1] ?? '').replace(/\t/g, '    ').length >= 2) {
      return {
        ok: false,
        line: n,
        detail: `${where} is nested under the item above it, and a criterion is one top-level line — fold it into that line or make it an item of its own`,
      };
    }
    const body = item[2] ?? '';
    if (body.length === 0) {
      return { ok: false, line: n, detail: `${where} is an empty list item` };
    }
    if (body.length > DOCUMENT_CRITERION_BODY_MAX) {
      return {
        ok: false,
        line: n,
        detail: `${where} is ${body.length} characters, and a criterion is at most ${DOCUMENT_CRITERION_BODY_MAX}`,
      };
    }
    if (body.includes(FILTERED)) {
      return {
        ok: false,
        line: n,
        detail: `${where} held a secret-shaped value that was redacted before it reached here, and a criterion is not written with a redaction in it — ask the person to reword that line without it`,
      };
    }
    if (criteria.length === DOCUMENT_CRITERIA_MAX) {
      return {
        ok: false,
        line: n,
        detail: `${where} would be criterion ${DOCUMENT_CRITERIA_MAX + 1}, and a revision holds at most ${DOCUMENT_CRITERIA_MAX} — split the list across requirements`,
      };
    }
    criteria.push({ body, line: n });
  }
  if (criteria.length === 0) {
    return {
      ok: false,
      line: null,
      detail: `${opts.file}${opts.section ? `, section "${opts.section}",` : ''} holds no list item to take as a criterion`,
    };
  }
  return { ok: true, criteria };
}
