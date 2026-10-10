// The dates and times a template's narrative and findings state, held to the instants its blocks
// show (REQ-32 BC-7, BC-17). The model is handed each instant as the UTC words a text no viewer is
// behind reads it ("Oct 10, 04:33 UTC", `narrative.ts:narrativeInput`), never the ISO a frame
// carries, so it has no ISO to repeat or cut short. What it writes back is judged here: an instant
// cut off after its day ("2026-10-10T") or one with no zone is refused, so is a date or time no
// block shows, and so is a time put beside a requirement whose own row does not hold it ("REQ-34 …
// at 10:46" when REQ-34's row holds 04:33). What passes is kept as the ISO of the instant it matched,
// the one form every screen reads in its viewer's zone and every export reads in UTC.

import { shownFrame, UTC_READING, type VisualBlock } from '@forge/contracts/visual-blocks';

/** One instant a block shows, with the words it is matched by and the keys of the row holding it. */
export interface Held {
  iso: string;
  /** Its UTC words: "Oct 10, 04:33 UTC", or "Oct 10" for a day with no time of its own. */
  words: string;
  /** Its UTC day, as ISO ("2026-10-10") and as words ("Oct 10"). */
  day: string;
  dayWords: string;
  /** Its UTC clock ("04:33"), or null for a day with no time of its own. */
  clock: string | null;
  keys: ReadonlySet<string>;
}

const KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const WHOLE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const ISO_IN_TEXT =
  /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))?/g;
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/;

function heldOf(iso: string, keys: ReadonlySet<string>): Held | null {
  const words = UTC_READING.instant(iso);
  if (words === iso) return null;
  const dayOnly = !words.includes(':');
  const day = dayOnly ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return {
    iso: dayOnly ? iso.slice(0, 10) : iso,
    words,
    day,
    dayWords: words.split(',')[0] as string,
    clock: dayOnly ? null : (/(\d{2}:\d{2}) UTC$/.exec(words)?.[1] ?? null),
    keys,
  };
}

/** Every instant the blocks show: a date cell, or an instant inside a text cell, with its row's keys. */
export function instantsShown(blocks: readonly VisualBlock[]): Held[] {
  const held: Held[] = [];
  for (const block of blocks) {
    const frame = shownFrame(block);
    if (!frame) continue;
    for (const row of frame.rows) {
      const keys = new Set<string>();
      for (const cell of Object.values(row)) {
        if (typeof cell === 'string' && WHOLE_KEY.test(cell.trim())) keys.add(cell.trim());
      }
      for (const field of frame.fields) {
        const cell = row[field.name];
        if (typeof cell !== 'string') continue;
        const found =
          field.type === 'date'
            ? [cell]
            : field.type === 'string'
              ? (cell.match(ISO_IN_TEXT) ?? [])
              : [];
        for (const iso of found) {
          const h = heldOf(iso, keys);
          if (h) held.push(h);
        }
      }
    }
  }
  return held;
}

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

/**
 * A date or time as a model writes one: whole ISO, the spaced UTC form, an instant cut off after its
 * day, a bare ISO day, the UTC words it was handed ("Oct 10, 04:33 UTC", "Oct 10 at 04:33", "Oct 10"),
 * or a clock alone ("04:33 UTC"). Leftmost wins, so a day's words take the clock that follows them.
 */
const PHRASE = new RegExp(
  [
    String.raw`(?<iso>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)`,
    String.raw`(?<spaced>\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? UTC)`,
    String.raw`(?<half>\d{4}-\d{2}-\d{2}T(?![A-Za-z])[\d:]*)`,
    String.raw`(?<date>\d{4}-\d{2}-\d{2})`,
    String.raw`(?<said>\b(?:${MONTHS}) \d{1,2}\b(?:,? (?:at )?\d{2}:\d{2}(?: UTC)?)?)`,
    String.raw`(?<clock>\b\d{1,2}:\d{2}\b(?: UTC)?)`,
  ].join('|'),
  'g',
);

interface Phrase {
  text: string;
  start: number;
  end: number;
  /** Why it is no instant at all, or how it is matched against what the blocks hold. */
  broken: string | null;
  matches: (h: Held) => boolean;
}

function phrasesIn(text: string): Phrase[] {
  const out: Phrase[] = [];
  for (const m of text.matchAll(PHRASE)) {
    const g = m.groups ?? {};
    const found = m[0];
    const at = { text: found, start: m.index, end: m.index + found.length };
    if (g.half !== undefined) {
      out.push({ ...at, broken: 'an instant cut off after its day', matches: () => false });
    } else if (g.iso !== undefined) {
      if (!ZONED.test(g.iso)) {
        out.push({ ...at, broken: 'an instant with no zone', matches: () => false });
        continue;
      }
      const words = UTC_READING.instant(g.iso);
      out.push({ ...at, broken: null, matches: (h) => h.clock !== null && h.words === words });
    } else if (g.spaced !== undefined) {
      const [day, clock] = g.spaced.split(' ');
      const words = UTC_READING.instant(`${day}T${clock}Z`);
      out.push({ ...at, broken: null, matches: (h) => h.clock !== null && h.words === words });
    } else if (g.date !== undefined) {
      out.push({ ...at, broken: null, matches: (h) => h.day === g.date });
    } else if (g.said !== undefined) {
      const said = /^(\w{3}) (\d{1,2})(?:,? (?:at )?(\d{2}:\d{2}))?/.exec(g.said);
      const dayWords = `${said?.[1]} ${said?.[2]}`;
      const clock = said?.[3];
      out.push({
        ...at,
        broken: null,
        matches: clock
          ? (h) => h.clock === clock && h.dayWords === dayWords
          : (h) => h.dayWords === dayWords,
      });
    } else {
      const clock = /^(\d{1,2}):(\d{2})/.exec(found);
      const hhmm = `${(clock?.[1] ?? '').padStart(2, '0')}:${clock?.[2]}`;
      out.push({ ...at, broken: null, matches: (h) => h.clock === hhmm });
    }
  }
  return out;
}

/** The ISO a matched phrase is kept as: a day stays a day, a time takes the instant it matched. */
const keptAs = (p: Phrase, h: Held): string => (/\d:\d/.test(p.text) ? h.iso : h.day);

/** Sentence by sentence; a full stop inside a number or an instant ("33.076Z") does not end one. */
const SENTENCE = /(?:[^.;!?]|[.;!?](?!\s|$))+(?:[.;!?]|$)/g;

export interface InstantsJudged {
  /** The text with each date and time it states kept as the ISO of the instant it matched. */
  text: string;
  /** The text with every date and time taken out, for the number check to read the rest. */
  rest: string;
  refusals: string[];
}

/**
 * Judges the dates and times one text states against the instants `held` (its blocks' for a slot,
 * its own block's for a finding). `name` opens each refusal ('slot "summary"', 'finding 2 (…)'),
 * `where` says where the instants it may state are ("no block shows", "its own block does not show").
 */
export function judgeInstants(
  text: string,
  held: readonly Held[],
  name: string,
  where: string,
): InstantsJudged {
  const refusals: string[] = [];
  const phrases = phrasesIn(text);
  const chosen = new Map<Phrase, Held>();
  for (const p of phrases) {
    if (p.broken) {
      refusals.push(
        `${name} states "${p.text}", ${p.broken}; write a date or time as its row shows it ("Oct 10, 04:33 UTC")`,
      );
      continue;
    }
    const match = held.find(p.matches);
    if (!match) refusals.push(`${name} states ${p.text}, which ${where}`);
    else chosen.set(p, match);
  }
  const keyed = new Map<string, Held[]>();
  for (const h of held) for (const k of h.keys) keyed.set(k, [...(keyed.get(k) ?? []), h]);
  for (const s of text.matchAll(SENTENCE)) {
    const from = s.index;
    const to = from + s[0].length;
    const inSentence = phrases.filter((p) => p.start >= from && p.end <= to && !p.broken);
    if (inSentence.length === 0) continue;
    const keysBetween = (a: number, b: number) =>
      [...text.slice(a, b).matchAll(KEY)].map((k) => k[0]).filter((k) => keyed.has(k));
    let after = from;
    const attached = inSentence.map((p) => {
      const keys = keysBetween(after, p.start);
      after = p.end;
      return { p, keys };
    });
    const last = attached.at(-1);
    if (last && last.keys.length === 0) last.keys = keysBetween(after, to);
    for (const { p, keys } of attached) {
      if (!chosen.has(p)) continue;
      const wrong = keys.filter((k) => !(keyed.get(k) ?? []).some(p.matches));
      if (wrong.length > 0) {
        const theirs = wrong
          .map((k) => `${k}: ${[...new Set((keyed.get(k) ?? []).map((h) => h.words))].join(', ')}`)
          .join('; ');
        refusals.push(
          `${name} puts ${wrong.join(', ')} at ${p.text}, which is not a time ${wrong.length === 1 ? 'its row holds' : 'their rows hold'} (${theirs}); state each requirement's own time`,
        );
      }
      const own = keys.map((k) => (keyed.get(k) ?? []).find(p.matches)).find(Boolean);
      if (own) chosen.set(p, own);
    }
  }
  let kept = '';
  let rest = '';
  let at = 0;
  for (const p of phrases) {
    const h = chosen.get(p);
    kept += text.slice(at, p.start) + (h ? keptAs(p, h) : p.text);
    rest += `${text.slice(at, p.start)} `;
    at = p.end;
  }
  return { text: kept + text.slice(at), rest: rest + text.slice(at), refusals };
}
