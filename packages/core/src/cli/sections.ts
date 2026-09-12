/**
 * Reading a markdown body into sections, so a kind's table can be asked what the body carries.
 *
 * The client half is `plugin/src/tracker/issue-shape.mjs` in the forge-plugin repo; the `cm:hack`
 * on `kinds.ts` carries the coupling and the condition that ends it.
 */

import { type SectionShape, SUBSTANTIAL_WORDS } from './kinds.js';

const HEADING = /^(#{1,6})[ \t]+(.*)$/gmu;
const FENCE = /^[ \t]*(?:```|~~~).*$[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$|^[ \t]*(?:```|~~~).*$[\s\S]*/gmu;

// cm:guard headings are scanned over a body whose fenced blocks are BLANKED to the same length, never over the raw text — a filing that pastes a complete-looking body inside one ``` fence carries no section at all and was read as carrying every one of them (F1, ISS-985); same-length blanking is what keeps every index below an index into the original
function scannable(body: string): string {
  return body.replace(FENCE, (block) => block.replace(/[^\n]/gu, ' '));
}

export type FoundSection = { readonly heading: string; readonly under: string };

// cm:guard a body's own title line is the PARENT of its sections and never one of them — read as a section it let any title answer for the section named after the same word (ISS-633); what tells the two apart is being the first heading AND shallower than every other one, so a level-2 section with level-3 subsections under it is still a section
function headingMatches(body: string): RegExpExecArray[] {
  const found = [...scannable(body).matchAll(HEADING)] as RegExpExecArray[];
  const titled =
    found.length > 1 &&
    (found[0]?.[1]?.length ?? 0) === 1 &&
    found.slice(1).every((one) => (one[1]?.length ?? 0) > 1);
  return titled ? found.slice(1) : found;
}

export function headingsOf(body: string): string[] {
  return headingMatches(body).map((one) => (one[2] ?? '').trim());
}

/** To the next heading of any depth: a section name with nothing under it is no section. */
export function sectionIn(body: string, wanted: RegExp): FoundSection | null {
  const found = headingMatches(body).find((one) => wanted.test(one[2] ?? ''));
  if (!found || found.index === undefined) return null;
  const rest = body.slice(found.index + found[0].length);
  const next = /^#{1,6}[ \t]+/mu.exec(rest);
  return {
    heading: (found[2] ?? '').trim(),
    under: next ? rest.slice(0, next.index) : rest,
  };
}

export function sectionUnder(body: string, wanted: RegExp): string | null {
  return sectionIn(body, wanted)?.under ?? null;
}

export function hasSubstantialLine(text: string | null | undefined): boolean {
  return String(text ?? '')
    .split('\n')
    .some(
      (line) =>
        line
          .replace(/^[-*\d.\s]+/u, '')
          .trim()
          .split(/\s+/u)
          .filter(Boolean).length >= SUBSTANTIAL_WORDS,
    );
}

export type SectionReading = {
  readonly under: string | null;
  readonly heading: string | null;
  readonly ok: boolean;
};

export function holds(body: string, section: SectionShape): SectionReading {
  const found = sectionIn(body, section.heading);
  const spoken = section.spoken?.test(body) ?? false;
  const ok =
    spoken ||
    (section.substantial ? hasSubstantialLine(found?.under) : Boolean(found?.under?.trim()));
  return { under: found?.under ?? null, heading: found?.heading ?? null, ok };
}
