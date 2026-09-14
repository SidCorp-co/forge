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

// cm:guard `deployed` is NOT here and must not be added: the tracker holds a merge stamp and a status and holds no deploy fact, so a rule claiming to check a deploy would be checking nothing and reporting a pass — which is the shape of evidence this issue exists to stop producing.
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

// cm:guard a status word is a PREDICATE or it is nothing. "take the issue to landed code", "ISS-757 assertion matches shipped classifier", "an already-merged branch" are the word used as an adjective on something that is not the issue, and every one of those three is a real line from this project's own comments that an earlier draft read as a claim. The test is the token after it: a predicate is followed by a preposition, a conjunction, a determiner, a number or punctuation — never by a bare noun.
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
  // cm:why an issue reference straight after the word is the OTHER assertion shape — "Merged ISS-807 to main", "closed ISS-996" — where the word is the verb and the issue is its object, not a noun it modifies.
  if (/^[A-Za-z][A-Za-z0-9]{1,5}-\d{1,6}$/.test(word)) return true;
  return PREDICATE_FOLLOWERS.has(word.toLowerCase());
}

// cm:guard the two directions get DIFFERENT windows, and that is measured rather than tidy. Reading backwards ("ISS-947 and ISS-948 are `closed` and merged") the widest gap any real assertion in the corpus has is five. Reading forwards the word is the verb and its object follows immediately ("Merged ISS-807 to main"), so anything wider is something else — "drift work merged too, so the epic ISS-589 now has..." is about the drift work, and a five-word forward window read it as a claim about the epic.
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

// cm:why a clause and not a sentence: "ISS-1 is merged, but ISS-2 is not" carries an assertion and a denial in one sentence, and binding the denial to both would abstain on a real claim while binding neither would refuse a true one. A bare ` but ` splits too, because it is a contrast strong enough to change what is being asserted; a bare ` and ` does NOT, because "ISS-947 and ISS-948 are closed and merged" would shred into four clauses holding nothing.
const CLAUSE_SPLIT_RE =
  /([.;:!?\n]+|,\s+(?:but|and|while|whereas|though|although)\b|\s+but\s+|\s+—\s+|\s+--\s+)/i;

interface Clause {
  readonly text: string;
  /** True where the clause was a question. The mark is a splitter, so it is kept here. */
  readonly asked: boolean;
}

// cm:guard the terminator is captured and carried, not discarded: `?` is both a clause boundary and the one signal that the clause was a QUESTION, and splitting it away read "Is ISS-996 merged?" as a claim that it is.
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

// cm:guard the status word binds to the reference in its OWN clause and to the nearest one — a comment naming two issues must be judged against two rows, and binding both words to the first reference is how a true statement about one gets refused because of the other (ISS-997 criterion 35).
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
