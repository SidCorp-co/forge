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
  /^[*_`"”’)\]]*\s+(?:(?:is not|isn't|is no longer|was not|wasn't|does not|doesn't)\s+(?:exist\b|(?:on|in|part of|held (?:by|on|in))\s+(?:[\w’'-]+\s+){0,5}?(?:tracker|project|backlog)\b)|(?:was not|wasn't|could not be|couldn't be|cannot be|can't be)\s+found\b)/i;

/** Before a key: the words that say there is no such issue — "there is no", "I couldn't find". */
const ABSENT_BEFORE =
  /\b(?:there is no|there's no|there isn't an?|no issue(?: called| named| keyed| with the key)?|could not find|couldn't find|cannot find|can't find|did not find|didn't find|found no)\s+(?:(?:an? )?issue\s+|key\s+)?[*_`"“‘([]*$/i;

/** Where a key is named, and whether that naming says the project does not hold it. */
export interface KeyMention {
  seq: number;
  /** The key as written. */
  token: string;
  absent: boolean;
}

/**
 * Every key a message names, each naming read in its own sentence: one saying the project does not hold
 * the key ("ISS-9 is not on this project's tracker", "there is no ISS-9") states a fact the tracker's
 * rows can check, and is not a citation (ISS-1229 r37, judge-100). Another naming of the same key is
 * read on its own.
 */
export function keyMentions(text: string, prefixes: readonly string[] = []): KeyMention[] {
  const out: KeyMention[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(issueTokenRe(prefixes))) {
      const at = m.index ?? 0;
      const absent =
        ABSENT_AFTER.test(sentence.slice(at + m[0].length)) ||
        ABSENT_BEFORE.test(sentence.slice(0, at));
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
