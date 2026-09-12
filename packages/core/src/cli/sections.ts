/**
 * Reading a markdown body into the sections a kind is judged against: which
 * headings are sections, what sits under one, and whether that text says
 * anything. Nothing here knows a kind — `kinds.ts` holds the table and
 * `shape.ts` asks the questions.
 */

import { SUBSTANTIAL } from './kinds.js';

const HEADING = /^(#{1,6})[ \t]+(.*)$/gmu;

export interface FoundSection {
  /** The heading text as the body wrote it. */
  readonly heading: string;
  /** Everything between that heading and the next one of any depth. */
  readonly under: string;
}

// cm:guard a body's own TITLE line is the parent of its sections and never one of them, and it arrives inside the body anyway. Read as a section it let any title answer for the section named after the same word (ISS-633). What tells a title from a section is being the FIRST heading and shallower than every other one, so a level-2 section with level-3 subsections under it is still a section.
function sectionMatches(body: string): RegExpMatchArray[] {
  const found = [...String(body).matchAll(HEADING)];
  const titled =
    found.length > 1 &&
    found[0]?.[1]?.length === 1 &&
    found.slice(1).every((one) => (one[1]?.length ?? 0) > 1);
  return titled ? found.slice(1) : found;
}

/** Every section heading in the body, in the order it wrote them. */
export function headingsOf(body: string): string[] {
  return sectionMatches(body).map((one) => (one[2] ?? '').trim());
}

// cm:guard to the next heading of ANY depth, never to the next one of the same depth: a section name with nothing under it is no section, and stopping at the same depth would let a subsection's text answer for its parent's floor
export function sectionIn(body: string, wanted: RegExp): FoundSection | null {
  const found = sectionMatches(body).find((one) => wanted.test(one[2] ?? ''));
  if (!found || found.index === undefined) return null;
  const rest = String(body).slice(found.index + found[0].length);
  const next = /^#{1,6}[ \t]+/mu.exec(rest);
  return {
    heading: (found[2] ?? '').trim(),
    under: next ? rest.slice(0, next.index) : rest,
  };
}

/** Whether any one line of this text reaches the substantial floor. */
export function hasLine(text: string | null | undefined): boolean {
  return String(text ?? '')
    .split('\n')
    .some(
      (line) =>
        line
          .replace(/^[-*\d.\s]+/u, '')
          .trim()
          .split(/\s+/u)
          .filter((word) => word.length > 0).length >= SUBSTANTIAL,
    );
}
