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

/** A `forge new` or `forge feedback` filing, or a `forge_issues` create in a turn recorded before that tool went. */
export function turnCreatedIssue(
  toolCalls: readonly { name: string; arguments: string }[],
): boolean {
  return toolCalls.some((t) => {
    if (t.name === 'forge_issues') return /"action"\s*:\s*"create"/.test(t.arguments);
    if (t.name !== 'forge') return false;
    try {
      const argv = (JSON.parse(t.arguments) as { argv?: unknown }).argv;
      return Array.isArray(argv) && (argv[0] === 'new' || argv[0] === 'feedback');
    } catch {
      return false;
    }
  });
}
