/** Recognising an issue reference in prose, and what it resolves to. */

import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';

/** The reference tokens this project answers to, as a regex. */
export function issueTokenRe(prefixes: readonly string[]): RegExp {
  const alts = [LEGACY_ISSUE_PREFIX, ...prefixes]
    .map((p) => p.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter((p) => p.length > 0);
  return new RegExp(`\\b(${[...new Set(alts)].join('|')})-(\\d{1,6})\\b`, 'gi');
}

/** An issue's documentId: any uuid, as the column holds it. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IssueClaims {
  urlIds: string[];
  malformedUrlIds: string[];
  issSeqs: number[];
}

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
  return { urlIds, malformedUrlIds, issSeqs };
}

// A reply saying it made an issue: the noun after the verb, or an issue key right after it.
// i18n-allow: the regex literals carry the Vietnamese phrasing of the creation claim they police
const ISSUE_NOUN_CLAIM_RE =
  /(?:(?:đã|vừa)\s+tạo\s+(?:một\s+)?(?:issue|task)|\b(?:created|opened|raised|filed)\s+(?:(?:a|an|the|new)\s+)*(?:issue|task|ticket)\b)/iu; // i18n-allow: matches the Vietnamese phrasing of the claim being policed

/**
 * The reply claims it created an issue. No chat door can: the kernel refuses a chat credential
 * `CHAT_FILES_FEEDBACK_NOT_ISSUES`, so the claim is false whatever the turn did.
 */
export function claimsIssueCreated(reply: string, prefixes: readonly string[] = []): boolean {
  if (ISSUE_NOUN_CLAIM_RE.test(reply)) return true;
  const key = issueTokenRe(prefixes).source;
  const verbs = '(?:\\bcreated|\\bopened|\\braised|(?:đã|vừa)\\s+tạo)'; // i18n-allow: the Vietnamese creation verb
  return new RegExp(`${verbs}\\s+(?:\\*\\*)?${key}`, 'iu').test(reply);
}
