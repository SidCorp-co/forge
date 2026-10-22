/** Recognising an issue reference in prose, and what it resolves to. */

import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';

/** The reference tokens this project answers to, as a regex. */
export function issueTokenRe(prefixes: readonly string[]): RegExp {
  const alts = [LEGACY_ISSUE_PREFIX, ...prefixes]
    .map((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter((p) => p.length > 0);
  return new RegExp(`\\b(${[...new Set(alts)].join('|')})-(\\d{1,6})\\b`, 'gi');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueClaims {
  urlIds: string[];
  malformedUrlIds: string[];
  issSeqs: number[];
  claimsCreation: boolean;
}

const CREATION_CLAIM_RE =
  // i18n-allow: the regex literal must carry the Vietnamese phrasing of the creation claim it matches
  /(đã|vừa)\s+tạo\s+(một\s+)?(issue|task)|created\s+(a\s+|an\s+|the\s+|new\s+)*(issue|task)/i; // i18n-allow: matches the Vietnamese phrasing of the claim being policed

export function extractIssueClaims(reply: string, prefixes: readonly string[] = []): IssueClaims {
  const urlIds: string[] = [];
  const malformedUrlIds: string[] = [];
  for (const m of reply.matchAll(/\/projects\/[^\s/]+\/issues\/([A-Za-z0-9-]+)/g)) {
    const id = m[1] as string;
    if (UUID_RE.test(id)) {
      if (!urlIds.includes(id)) urlIds.push(id);
    } else if (!malformedUrlIds.includes(id)) {
      malformedUrlIds.push(id);
    }
  }
  const issSeqs: number[] = [];
  for (const m of reply.matchAll(issueTokenRe(prefixes))) {
    const seq = Number(m[2]);
    if (!issSeqs.includes(seq)) issSeqs.push(seq);
  }
  return { urlIds, malformedUrlIds, issSeqs, claimsCreation: CREATION_CLAIM_RE.test(reply) };
}

/** After a key: the words that say this project does not hold it — "is not on this project's tracker". */
const ABSENT_AFTER =
  /^[*_`"”’)\]]*\s+(?:(?:is not|isn't|is no longer|does not|doesn't)\s+(?:exist\b|(?:on|in|part of|held (?:by|on|in))\s+(?:[\w’'-]+\s+){0,5}?(?:tracker|project)\b)|(?:was not|wasn't|could not be|couldn't be|cannot be|can't be)\s+found\b)/i;

/** A clause's opening up to its key: the key itself, or "there is no" / "I couldn't find" before it. */
const OPENS_ON_KEY = /^\s*(?:(?:and|but|so)\s+)?[*_`"“‘([]*$/i;
const OPENS_ON_ABSENCE =
  /^\s*(?:(?:and|but|so)\s+)?(?:there is no|there's no|there isn't an?|no issue(?: called| named| keyed| with the key)?|(?:i\s+)?(?:could not|couldn't|cannot|can't|did not|didn't) find|(?:i\s+)?found no)\s+(?:(?:an? )?issue\s+|key\s+)?[*_`"“‘([]*$/i;

/** What may follow a key after "there is no": the clause's end, or the project it is absent from. */
const ABSENT_TAIL =
  /^[*_`"”’)\]]*(?:\s+(?:(?:on|in)\s+(?:[\w’'-]+\s+){0,5}?(?:tracker|project)(?:['’]s\s+(?:tracker|issues))?|here)\b)?[*_`"”’)\]]*\s*(?:[.!,;:—–]|$)/i;

const CLAUSE_CUT = /[,;:—–]\s+|\n\s*/g;
const ASKS_BACK = /^\s*(?:(?:and|so|but)\s+)?(?:please\s+)?(?:tell me|let me know)\b/i;
const CONDITIONAL = /\b(?:if|unless|whether|suppose|supposing|in case|assuming|provided)\b/i;
/** A scope narrower than the project, or a time other than now: either leaves absence unasserted. */
const NOT_NOW_OR_NARROWER =
  /\b(?:(?:in|on|from|of)\s+(?:[\w’'-]+\s+){0,3}?(?:sprint|milestone|board|column|release|filter|search|page|list|view)|yesterday|earlier|previously|last|ago|until|anymore|any longer|used to|at the time)\b/i;

/** A plain, present, unconditional absence: its clause opens on the key or "there is no", in no question. */
function assertsAbsence(sentence: string, at: number, after: string): boolean {
  const cuts = [...sentence.matchAll(CLAUSE_CUT)].map((c) => (c.index ?? 0) + c[0].length);
  const opening = sentence.slice(Math.max(0, ...cuts.filter((c) => c <= at)), at);
  const conditions = sentence.split(CLAUSE_CUT).filter((clause) => !ASKS_BACK.test(clause));
  if (/\?[\s*_`"”’)\]]*$/.test(sentence) || NOT_NOW_OR_NARROWER.test(sentence)) return false;
  if (conditions.some((clause) => CONDITIONAL.test(clause))) return false;
  return (
    (OPENS_ON_KEY.test(opening) && ABSENT_AFTER.test(after)) ||
    (OPENS_ON_ABSENCE.test(opening) && ABSENT_TAIL.test(after))
  );
}

/** Where a key is named, and whether that naming says the project does not hold it. */
export interface KeyMention {
  seq: number;
  /** The key as written. */
  token: string;
  absent: boolean;
}

/**
 * Every key a message names, each read in its own sentence: one saying the project does not hold it
 * ("ISS-9 is not on this project's tracker", "there is no ISS-9") states a fact the tracker's rows
 * check, not a citation (ISS-1229 r37, judge-100).
 */
export function keyMentions(text: string, prefixes: readonly string[] = []): KeyMention[] {
  const out: KeyMention[] = [];
  for (const sentence of text.split(/(?<=[.!?][*_`"”’)\]]*)\s+|\n\s*\n/)) {
    for (const m of sentence.matchAll(issueTokenRe(prefixes))) {
      const at = m.index ?? 0;
      const absent = assertsAbsence(sentence, at, sentence.slice(at + m[0].length));
      out.push({ seq: Number(m[2]), token: m[0], absent });
    }
  }
  return out;
}

export function turnCreatedIssue(
  toolCalls: readonly { name: string; arguments: string }[],
): boolean {
  return toolCalls.some(
    (t) => t.name === 'forge_issues' && /"action"\s*:\s*"create"/.test(t.arguments),
  );
}
