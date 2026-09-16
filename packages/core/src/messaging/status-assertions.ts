/**
 * Reading a status claim an agent made about a named issue, so it can be
 * checked against what the tracker holds.
 *
 * The grammar is deliberately narrow and ABSTAINS by default: a construction it
 * does not recognise yields no assertion and the message is written. A false
 * refusal is a tax on every agent in the fleet; a missed claim is what the
 * tracker already lives with (ISS-997).
 */

// cm:ignore CM013 — the Vietnamese alternatives below are the phrasing agents on this project actually write, and the abstention markers must carry them or the grammar reads a denial as a claim.

import { issueTokenRe } from './issue-tokens.js';

/** What the tracker is asked about. Only what the tracker actually holds. */
export type StatusClaim = 'merged' | 'closed';

export interface StatusAssertion {
  readonly seq: number;
  readonly claim: StatusClaim;
  /** The clause it was read from, quoted back so a writer can find it. */
  readonly quote: string;
}

/**
 * Is this status word half of a hyphenated compound, and so an adjective?
 */
function inCompound(clause: string, at: number, length: number): boolean {
  return clause[at - 1] === '-' || clause[at + length] === '-';
}

const STATUS_WORDS: ReadonlyArray<readonly [RegExp, StatusClaim]> = [
  [/\b(merged|shipped|landed)\b/gi, 'merged'],
  [/\bclosed\b/gi, 'closed'],
];

/** Where the writer is denying the status rather than asserting it. */
const NEGATION_RE =
  /\b(not|never|no longer|isn't|wasn't|hasn't|haven't|aren't|doesn't|didn't|cannot|can't|won't|without)\b|\bchưa\b|\bkhông\b/i; // i18n-allow: `chưa` and `không` are how a Vietnamese denial is written, and the rules being read carry Vietnamese

/** Where the status is the consequent of something, not a fact. */
const CONDITION_RE =
  /\b(if|once|when|until|before|after|unless|assuming|pending|provided|whether|so that|now that|in order to|ready to|about to|waiting)\b/i;

/** Where the status is somebody else's claim being repeated. */
const ATTRIBUTION_RE =
  /\b(said|says|claims?|claimed|according to|reports?|reported|told|per|quoting|wrote)\b/i;

/** Where the writer is hedging rather than stating. */
const MODALITY_RE =
  /\b(may|might|could|should|would|will|shall|must|appears?|seems?|likely|probably|possibly|maybe|perhaps|think|thinks|believe|believes|assume|assumes|expect|expects|hope|suppose|presumably|apparently|allegedly)\b/i;

/** Where the writer is narrating the status being undone. */
const REVERSAL_RE =
  /\b(rolled back|roll back|reverted|revert|undone|backed out|reopened|unmarked|unmerged)\b/i;

const ABSTAIN: readonly RegExp[] = [
  NEGATION_RE,
  CONDITION_RE,
  ATTRIBUTION_RE,
  MODALITY_RE,
  REVERSAL_RE,
];

const PREDICATE_FOLLOWERS = new Set([
  'at',
  'as',
  'on',
  'in',
  'to',
  'into',
  'and',
  'or',
  'but',
  'with',
  'under',
  'via',
  'from',
  'since',
  'after',
  'before',
  'too',
  'now',
  'yet',
  'here',
  'there',
  'already',
  'by',
  'for',
  'so',
  'when',
  'while',
  'it',
  'this',
  'that',
  'the',
  'a',
  'an',
  'its',
  'their',
  'his',
  'her',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'both',
  'all',
  'earlier',
  'later',
  'today',
  'last',
  'next',
  'again',
  'then',
  'plus',
]);

function isPredicate(rest: string): boolean {
  const next = /^\s+([A-Za-z][\w'-]*)/.exec(rest);
  if (!next) return true;
  const word = next[1] as string;
  if (/^[A-Za-z][A-Za-z0-9]{1,5}-\d{1,6}$/.test(word)) return true;
  return PREDICATE_FOLLOWERS.has(word.toLowerCase());
}

const MAX_WORDS_BEFORE = 5;
const MAX_WORDS_FORWARD = 1;

function wordsBetween(clause: string, a: number, b: number): number {
  const span = clause.slice(Math.min(a, b), Math.max(a, b));
  return (span.match(/[A-Za-z0-9][\w'-]*/g) ?? []).length;
}

/** Blank out what is quoted rather than said: fenced blocks, inline code, blockquote lines. */
function stripQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length))
    .replace(/^[ \t]*>.*$/gm, (m) => ' '.repeat(m.length));
}

const CLAUSE_SPLIT_RE =
  /([.;:!?\n]+|,\s+(?:but|and|while|whereas|though|although)\b|\s+but\s+|\s+—\s+|\s+--\s+)/i;

interface Clause {
  readonly text: string;
  /** True where the clause was a question. The mark is a splitter, so it is kept here. */
  readonly asked: boolean;
}

function clausesOf(text: string): Clause[] {
  const pieces = stripQuoted(text).split(CLAUSE_SPLIT_RE);
  const out: Clause[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const body = (pieces[i] ?? '').trim();
    if (!body) continue;
    out.push({ text: body, asked: (pieces[i + 1] ?? '').includes('?') });
  }
  return out;
}

interface Hit {
  readonly at: number;
  readonly seq: number;
}

function referencesIn(clause: string, prefixes: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const m of clause.matchAll(issueTokenRe(prefixes))) {
    hits.push({ at: m.index ?? 0, seq: Number(m[2]) });
  }
  return hits;
}

function bind(hits: readonly Hit[], at: number): Hit | null {
  let before: Hit | null = null;
  for (const h of hits) if (h.at < at && (!before || h.at > before.at)) before = h;
  if (before) return before;
  let after: Hit | null = null;
  for (const h of hits) if (h.at >= at && (!after || h.at < after.at)) after = h;
  return after;
}

/**
 * Every status a message ASSERTS of an issue it names. Anything the grammar
 * does not recognise as an assertion is simply absent from the result.
 */
export function extractStatusAssertions(
  text: string,
  prefixes: readonly string[],
): StatusAssertion[] {
  const found: StatusAssertion[] = [];
  const seen = new Set<string>();
  for (const { text: clause, asked } of clausesOf(text)) {
    if (asked) continue;
    if (ABSTAIN.some((re) => re.test(clause))) continue;
    const hits = referencesIn(clause, prefixes);
    if (hits.length === 0) continue;
    for (const [wordRe, claim] of STATUS_WORDS) {
      for (const m of clause.matchAll(wordRe)) {
        const at = m.index ?? 0;
        if (inCompound(clause, at, (m[0] as string).length)) continue;
        if (!isPredicate(clause.slice(at + (m[0] as string).length))) continue;
        const hit = bind(hits, at);
        if (hit === null) continue;
        const gap = wordsBetween(clause, hit.at, at);
        const window = hit.at < at ? MAX_WORDS_BEFORE + 1 : MAX_WORDS_FORWARD + 1;
        if (gap > window) continue;
        const seq = hit.seq;
        const k = `${seq}:${claim}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ seq, claim, quote: clause });
      }
    }
  }
  return found;
}
