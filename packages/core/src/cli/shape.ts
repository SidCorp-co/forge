/**
 * Every gap a title and a body decide with no tracker read, and the notice a shortfall no gap
 * refuses earns.
 *
 * A gap is three parts because a refusal is: what was read, what the shape wants, and the one
 * thing that clears it.
 */

import {
  article,
  KIND_NAMES,
  KIND_WANTS,
  type KindShape,
  kindRefusal,
  type SectionShape,
  SUBSTANTIAL_WORDS,
  shapeFor,
} from './kinds.js';
import { headingsOf, holds, type SectionReading } from './sections.js';

export type FilingGap = { readonly read: string; readonly wants: string; readonly clear: string };

export type FilingReading = {
  readonly gaps: readonly FilingGap[];
  readonly notice: string | null;
};

const RESEND = 'and send the filing again';
const RETITLE = 'give a title saying what is true after the change';

function gap(read: string, wants: string, clear: string): FilingGap {
  return { read, wants, clear };
}

const TITLE_WORD = /[A-Za-z][A-Za-z'-]*/gu;
const PATH_IN_TITLE =
  /[\w.@-]*\/[\w./-]+|\.(?:mjs|cjs|js|jsx|ts|tsx|md|json|html|css|py|sh|ya?ml)\b/u;
const WORK_VERB = new Set(
  (
    'fix fixes fixed update updates updated add adds added remove removes removed delete deletes ' +
    'change changes changed rename renames move moves refactor refactors replace replaces improve ' +
    'improves tweak tweaks correct corrects handle handles support supports implement implements ' +
    'make makes makeover do does drop drops restore restores split splits extend extends'
  ).split(' '),
);
const CARRIER = new Set('a an the to for of in on at and or it its this that'.split(' '));

function titleGaps(title: string): FilingGap[] {
  const words = title.match(TITLE_WORD) ?? [];
  const out: FilingGap[] = [];
  if (words.length < 2) {
    out.push(
      gap(
        `the title \`${title}\``,
        'a sentence saying the behaviour after the change, not one word',
        RETITLE,
      ),
    );
  } else if (
    words.every((one) => CARRIER.has(one.toLowerCase()) || WORK_VERB.has(one.toLowerCase()))
  ) {
    out.push(
      gap(
        `the title \`${title}\``,
        'what is true after the change, which a work verb alone never says',
        RETITLE,
      ),
    );
  }
  if (PATH_IN_TITLE.test(title)) {
    out.push(
      gap(
        `a file path in the title \`${title}\``,
        'the behaviour, and the path in the body where a reader can act on it',
        RETITLE,
      ),
    );
  }
  return out;
}

const CODE_SPAN = /`([^`\n]+)`/gu;
const MODAL = /\b(?:should|must|shall|needs? to|ought to)\b/iu;
const JOIN = ' and ';
const SENTENCE = /[^.!?\n]+[.!?]/gu;

function firstSpan(text: string): string | null {
  return [...text.matchAll(CODE_SPAN)].map((one) => (one[1] ?? '').trim())[0] ?? null;
}

// cm:guard both sides need a modal AND a DIFFERENT named token — two claims about one token are one change described twice, and without that second name a lexical read cannot tell two clauses of one outcome from two outcomes
export function twoChangesIn(body: string): { sentence: string; named: string[] } | null {
  for (const [sentence] of body.matchAll(SENTENCE)) {
    for (let at = sentence.indexOf(JOIN); at >= 0; at = sentence.indexOf(JOIN, at + 1)) {
      const left = sentence.slice(0, at);
      const right = sentence.slice(at + JOIN.length);
      const one = firstSpan(left);
      const two = firstSpan(right);
      if (MODAL.test(left) && MODAL.test(right) && one && two && one !== two) {
        return { sentence: sentence.trim(), named: [one, two] };
      }
    }
  }
  return null;
}

const PARTS_PHRASE = /\b(?:parts?|children|sub-?issues?|split into|consists of|made up of)\b/giu;
const BARE = /^parts?$/iu;
const LABEL = /\([^()]*\)/gu;
const KEY = /\bISS-\d+\b/giu;
const GOVERNED =
  /^(?<link>(?:[\s`*_]*[:=]|\s+(?:are|is|both|these|the following)\b)*)[\s`*_]*(?<keys>ISS-\d+\b(?:[\s`*_]*(?:\([^()]{0,40}\))?[\s`*_]*(?:,\s*and|,|;|and|&)[\s`*_]*ISS-\d+\b)+)/iu;

// cm:guard the phrase must GOVERN the keys — a line merely holding both is a cross-reference (ISS-336), and two keys rather than one because a body may legitimately cite the issue it sits beside
export function partsIn(body: string): { line: string; keys: string[] } | null {
  for (const line of body.split('\n')) {
    for (const phrase of line.matchAll(PARTS_PHRASE)) {
      const found = GOVERNED.exec(line.slice((phrase.index ?? 0) + phrase[0].length));
      const named = found?.groups?.keys;
      if (!named) continue;
      if (BARE.test(phrase[0]) && !found?.groups?.link) continue;
      const keys = [
        ...new Set((named.replace(LABEL, ' ').match(KEY) ?? []).map((one) => one.toUpperCase())),
      ];
      if (keys.length >= 2) return { line: line.trim(), keys };
    }
  }
  return null;
}

function readFor(section: SectionShape, found: SectionReading, among: string): string {
  if (found.under !== null) {
    const floor = section.substantial ? ` of ${SUBSTANTIAL_WORDS} words or more` : '';
    return `${article(section.bare)} ${section.bare} heading \`${found.heading}\` with nothing under it${floor}`;
  }
  const spoken = section.spoken ? ', and no line saying there is none' : '';
  return `no heading naming ${section.reads}, ${among}${spoken}`;
}

// cm:guard the heading quoted is the one `sectionIn` found, which is the FIRST of a family — quoting the section's own title instead would send a filer to write under a heading that is not the one being read, and a second thin heading below it would still be the one answering
function clearFor(section: SectionShape, found: SectionReading): string {
  if (found.under === null) return `add \`${section.add}\` ${RESEND}`;
  const floor = section.substantial ? `one line of ${SUBSTANTIAL_WORDS} words or more` : 'one line';
  return `write ${floor} under the heading \`${found.heading}\` already there ${RESEND}`;
}

function sectionGaps(body: string, shape: KindShape, among: string): FilingGap[] {
  return shape.needs.flatMap((section) => {
    const found = holds(body, section);
    if (found.ok) return [];
    return [
      gap(
        readFor(section, found, among),
        `${section.wants}, required of ${article(shape.kind)} ${shape.kind}`,
        clearFor(section, found),
      ),
    ];
  });
}

/** One line or nothing: what the body was read as, and which nice-to-have sections it left out. */
export function noticeFor(kind: string, left: readonly SectionShape[]): string | null {
  if (left.length === 0) return null;
  return (
    `Read as ${article(kind)} ${kind}. It leaves out ${left.map((one) => one.title).join(', ')}, ` +
    `nice to have on ${article(kind)} ${kind} and refused on nothing.`
  );
}

export type FilingInput = {
  readonly title: string;
  readonly body: string;
  readonly category: string;
};

/** Every gap the title and the body decide, in the order a filer meets them. */
export function readFiling(filing: FilingInput): FilingReading {
  const body = filing.body ?? '';
  if (!body.trim()) {
    return {
      gaps: [
        gap(
          `${body.length} character(s) of body and no text in them`,
          'the issue itself: what is true after the change, the rule that says so, and what is out of scope',
          'write the body and send the filing again',
        ),
      ],
      notice: null,
    };
  }

  const gaps = titleGaps(filing.title ?? '');

  const split = twoChangesIn(body);
  if (split) {
    gaps.push(
      gap(
        `one sentence asking for two changes — "${split.sentence}"`,
        `one change per issue: a sibling for ${split.named.join(' and ')}, each body naming the others`,
        'file each of them on its own, one filing per change',
      ),
    );
  }

  const parts = partsIn(body);
  if (parts) {
    gaps.push(
      gap(
        `a line naming ${parts.keys.join(' and ')} as this issue's parts`,
        "the parts themselves as issues, held on an edge rather than claimed in this body's prose",
        `take the claim off the line and send the filing again with a \`blocks\` relation to ${parts.keys.join(', ')}`,
      ),
    );
  }

  // cm:guard the undefined-category gap returns BEFORE the sections are read — a category nobody has decided the sections of has no section list to read a body against, so reporting section gaps under it would name a shape this layer never defined
  const shape = shapeFor(filing.category);
  if (!shape) {
    gaps.push(
      gap(
        `a category of \`${filing.category}\`, which this CLI layer does not define`,
        KIND_WANTS,
        `${kindRefusal(filing.category).split('\n')[0]} Name one of ${KIND_NAMES.join(', ')} ${RESEND}`,
      ),
    );
    return { gaps, notice: null };
  }

  const headings = headingsOf(body);
  const among = headings.length
    ? `among ${headings.map((one) => `\`${one}\``).join(', ')}`
    : 'and the body has no heading at all';
  gaps.push(...sectionGaps(body, shape, among));

  const left = shape.says.filter((section) => !holds(body, section).ok);
  return { gaps, notice: noticeFor(shape.kind, left) };
}
