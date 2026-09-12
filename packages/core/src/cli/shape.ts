/**
 * Every gap a filing's title and body decide with no tracker read: the kind
 * itself, the sections it owes, and the three claims a body makes that belong
 * on an edge or on a sibling issue rather than in prose.
 *
 * A gap is returned, never thrown. What clears it is the caller's route —
 * `refusal.ts` renders these for the CLI door, and nothing here knows which
 * door asked.
 */

import {
  type CliKind,
  type CliSection,
  KIND_NAMES,
  SUBSTANTIAL,
  article,
  kindNeeded,
  kindRefusal,
  listed,
  shapeFor,
} from './kinds.js';
import { hasLine, headingsOf, sectionIn } from './sections.js';

/** Which rule refused, beside the text a person reads: a caller branching on the prose is matching a paragraph written for somebody else. */
export type CliGapKind =
  | 'body'
  | 'title'
  | 'category'
  | 'split'
  | 'parts'
  | 'section'
  | 'duplicate'
  | 'detector';

export interface CliGap {
  /** Which rule this gap is. */
  readonly because: CliGapKind;
  /** What was read of the filing. */
  readonly read: string;
  /** What the shape wants there instead. */
  readonly wants: string;
  /** The one command that clears it. */
  readonly clear: string;
}

export interface CliShape {
  readonly gaps: readonly CliGap[];
  /** Sections this kind only suggests, and this body left out. */
  readonly left: readonly CliSection[];
  /** The kind the body was read against, or null when the gap is the kind. */
  readonly kind: CliKind | null;
}

const RESEND = 'and re-send the same call';
const RETITLE = 'set the title to what is true after the change';

function gap(because: CliGapKind, read: string, wants: string, clear: string): CliGap {
  return { because, read, wants, clear };
}

const TITLE_WORD = /[A-Za-z][A-Za-z'-]*/gu;
const PATH_IN_TITLE = /[\w.@-]*\/[\w./-]+|\.(?:mjs|cjs|js|jsx|ts|tsx|md|json|html|css|py|sh|ya?ml)\b/u;
const WORK_VERB = new Set(
  (
    'fix fixes fixed update updates updated add adds added remove removes removed delete deletes ' +
    'change changes changed rename renames move moves refactor refactors replace replaces improve ' +
    'improves tweak tweaks correct corrects handle handles support supports implement implements ' +
    'make makes makeover do does drop drops restore restores split splits extend extends'
  ).split(' '),
);
const CARRIER = new Set('a an the to for of in on at and or it its this that'.split(' '));

export function titleGaps(title: string): CliGap[] {
  const words = String(title).match(TITLE_WORD) ?? [];
  const out: CliGap[] = [];
  if (words.length < 2) {
    out.push(
      gap(
        'title',
        `the title \`${title}\``,
        'a sentence saying the behaviour after the change, not one word',
        RETITLE,
      ),
    );
  } else if (words.every((one) => CARRIER.has(one.toLowerCase()) || WORK_VERB.has(one.toLowerCase()))) {
    out.push(
      gap(
        'title',
        `the title \`${title}\``,
        'what is true after the change, which a work verb alone never says',
        RETITLE,
      ),
    );
  }
  if (PATH_IN_TITLE.test(String(title))) {
    out.push(
      gap(
        'title',
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

// cm:guard both sides must name a DIFFERENT token for this to fire. Two claims about one token are one change described twice, and without that second name a lexical read cannot tell two clauses of one outcome from two outcomes.
export function twoChangesIn(body: string): { sentence: string; named: [string, string] } | null {
  for (const [sentence] of String(body).matchAll(SENTENCE)) {
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

const ISSUE_KEY = /\bISS-\d+\b/giu;
const PARTS_PHRASE = /\b(?:parts?|children|sub-?issues?|split into|consists of|made up of)\b/giu;
const BARE_PART = /^parts?$/iu;
const LABEL = /\([^()]*\)/gu;
// cm:guard forward only, a bare "part" through a connective or not at all, and a label only between a key and its separator: without those three the arm catches "ISS-a and ISS-b split into the halves", "a guide part ISS-a (the lesson) and ISS-b", and a citation inside a label read as a part
const GOVERNED =
  /^(?<link>(?:[\s`*_]*[:=]|\s+(?:are|is|both|these|the following)\b)*)[\s`*_]*(?<keys>ISS-\d+\b(?:[\s`*_]*(?:\([^()]{0,40}\))?[\s`*_]*(?:,\s*and|,|;|and|&)[\s`*_]*ISS-\d+\b)+)/iu;

/** Two keys the phrase GOVERNS, never a line that merely holds both — that is a cross-reference (ISS-336); two because one may cite the issue this body sits beside. */
export function partsIn(body: string): { line: string; keys: string[] } | null {
  for (const line of String(body).split('\n')) {
    for (const phrase of line.matchAll(PARTS_PHRASE)) {
      if (phrase.index === undefined) continue;
      const found = GOVERNED.exec(line.slice(phrase.index + phrase[0].length));
      if (!found?.groups || (BARE_PART.test(phrase[0]) && !found.groups.link)) continue;
      const claimed = String(found.groups.keys ?? '').replace(LABEL, ' ');
      const keys = [...new Set((claimed.match(ISSUE_KEY) ?? []).map((one) => one.toUpperCase()))];
      if (keys.length >= 2) return { line: line.trim(), keys };
    }
  }
  return null;
}

interface Held {
  readonly under: string | null;
  readonly heading: string | null;
  readonly ok: boolean;
}

function held(text: string, part: CliSection): Held {
  const found = sectionIn(text, part.heading);
  const spoken = part.spoken?.test(text) ?? false;
  const ok = spoken || (part.substantial ? hasLine(found?.under) : Boolean(found?.under?.trim()));
  return { under: found?.under ?? null, heading: found?.heading ?? null, ok };
}

function readFor(part: CliSection, found: Held, among: string): string {
  if (found.under !== null) {
    const floor = part.substantial ? ` of ${SUBSTANTIAL} words or more` : '';
    return `${article(part.bare)} ${part.bare} heading \`${found.heading}\` with nothing under it${floor}`;
  }
  const spoken = part.spoken ? ', and no line saying there is none' : '';
  return `no heading naming ${part.reads}, ${among}${spoken}`;
}

// cm:guard the heading quoted is the one that was READ: `sectionIn` takes the FIRST of a family, so a second heading added below it would leave the thin one still answering for the section
function clearFor(part: CliSection, found: Held): string {
  if (found.under === null) return `add \`## ${part.title}\` ${RESEND}`;
  const floor = part.substantial ? `one line of ${SUBSTANTIAL} words or more` : 'one line';
  return `write ${floor} under the heading \`${found.heading}\` already there ${RESEND}`;
}

function sectionGaps(text: string, shape: CliKind, among: string): CliGap[] {
  return shape.needs.flatMap((part) => {
    const found = held(text, part);
    if (found.ok) return [];
    return [
      gap(
        'section',
        readFor(part, found, among),
        `${part.wants}, required of ${article(shape.kind)} ${shape.kind}`,
        clearFor(part, found),
      ),
    ];
  });
}

function amongOf(text: string): string {
  const headings = headingsOf(text);
  return headings.length
    ? `among ${headings.map((one) => `\`${one}\``).join(', ')}`
    : 'and the body has no heading at all';
}

function claimGaps(text: string): CliGap[] {
  const out: CliGap[] = [];
  const split = twoChangesIn(text);
  if (split) {
    out.push(
      gap(
        'split',
        `one sentence asking for two changes — "${split.sentence}"`,
        `one change per issue: a sibling for ${split.named.join(' and ')}, each body naming the others`,
        'file each of them on its own, one filing per change',
      ),
    );
  }
  const parts = partsIn(text);
  if (parts) {
    out.push(
      gap(
        'parts',
        `a line naming ${parts.keys.join(' and ')} as this issue's parts`,
        'the parts themselves as issues, held on an edge rather than claimed in this body\'s prose',
        `take the claim off the line and relate ${parts.keys.join(', ')} in the same create`,
      ),
    );
  }
  return out;
}

// cm:guard both arms REFUSE, and which one speaks is the only question: a payload carrying `category` as `""` or as spaces has named nothing, so it takes the refusal that says a category is needed rather than `No category named .`, which reads as a typo nobody made. Neither arm ever defaults — a category nobody decided the sections of is not made one by the body looking tidy.
export function categoryGap(given: string | null | undefined): CliGap | null {
  const named = given?.trim();
  if (named === undefined || named === '') {
    return gap(
      'category',
      'a filing naming no category',
      `one of ${listed(KIND_NAMES)}`,
      kindNeeded(),
    );
  }
  if (!KIND_NAMES.includes(named)) {
    return gap(
      'category',
      `a category of \`${named}\`, which this layer does not define`,
      `one of ${listed(KIND_NAMES)}`,
      kindRefusal(named),
    );
  }
  return null;
}

/** The kind is decided BEFORE the sections and they are never read without one: a category nobody has decided the sections of is not made one by the body looking tidy. */
export function readFiling(filing: {
  title?: string | null;
  body?: string | null;
  category?: string | null;
}): CliShape {
  const text = String(filing.body ?? '');
  const kind = filing.category ?? null;
  if (!text.trim()) {
    return {
      gaps: [
        gap(
          'body',
          `${text.length} character(s) of body and no text in them`,
          'the issue itself: what is true after the change, the rule that says so, and what is out of scope',
          'send the body with the filing',
        ),
      ],
      left: [],
      kind: null,
    };
  }
  const gaps = titleGaps(filing.title ?? '');
  gaps.push(...claimGaps(text));
  const missing = categoryGap(kind);
  if (missing) {
    gaps.push(missing);
    return { gaps, left: [], kind: null };
  }
  const shape = shapeFor(String(kind).trim()) as CliKind;
  gaps.push(...sectionGaps(text, shape, amongOf(text)));
  return { gaps, left: shape.says.filter((part) => !held(text, part).ok), kind: shape };
}
