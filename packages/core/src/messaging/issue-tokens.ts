/** Recognising an issue reference in prose, and what it resolves to. */

import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';

/** The reference tokens this project answers to, as a regex. */
// cm:guard the project's OWN prefixes are passed in, never assumed: a message citing `FD-977` on a project whose prefix is `FD` would match nothing here and sail past the did-you-verify-it rule, which is the one thing these rules exist to catch (ISS-992). This module stays db-free, so they arrive as data.
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
  // cm:ignore CM001 — i18n-allow: the regex literal must carry the Vietnamese phrasing of the creation claim it matches
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

export function turnCreatedIssue(
  toolCalls: readonly { name: string; arguments: string }[],
): boolean {
  return toolCalls.some(
    (t) => t.name === 'forge_issues' && /"action"\s*:\s*"create"/.test(t.arguments),
  );
}
