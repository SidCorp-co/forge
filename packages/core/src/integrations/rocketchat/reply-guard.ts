/**
 * Kernel guard against HALLUCINATED ACTIONS in bot replies (kernel-hard,
 * policy-soft): the persona already forbids announcing work that wasn't done,
 * but a weak model can still answer with zero tool calls claiming "I created
 * an issue" plus a fabricated link (live incident 2026-07-07: invented
 * `/issues/6673627998492006400` — not even a UUID). This module extracts the
 * verifiable claims from a reply; the connection-manager checks them against
 * the turn's actual tool calls + the DB and blocks the reply when they fail.
 *
 * Pure string analysis — no db/env imports — so it unit-tests standalone.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueClaims {
  /** Ids found in forge issue URLs (`…/projects/<slug>/issues/<id>`). */
  urlIds: string[];
  /** Ids from URLs that are not even UUID-shaped — fabricated by construction. */
  malformedUrlIds: string[];
  /** `ISS-<n>` sequence numbers referenced in the text. */
  issSeqs: number[];
  /** Reply claims to have created an issue (vi/en phrasing). */
  claimsCreation: boolean;
}

const CREATION_CLAIM_RE =
  /(đã|vừa)\s+tạo\s+(một\s+)?(issue|task)|created\s+(a\s+|an\s+|the\s+|new\s+)*(issue|task)/i; // i18n-allow: matches the Vietnamese phrasing of the claim being policed

export function extractIssueClaims(reply: string): IssueClaims {
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
  for (const m of reply.matchAll(/\bISS-(\d{1,6})\b/g)) {
    const seq = Number(m[1]);
    if (!issSeqs.includes(seq)) issSeqs.push(seq);
  }
  return {
    urlIds,
    malformedUrlIds,
    issSeqs,
    claimsCreation: CREATION_CLAIM_RE.test(reply),
  };
}

/** Did this turn actually run a `forge_issues` create? (Best-effort: the tool
 *  call record carries name + raw arguments, not the result.) */
export function turnCreatedIssue(toolCalls: Array<{ name: string; arguments: string }>): boolean {
  return toolCalls.some(
    (t) => t.name === 'forge_issues' && /"action"\s*:\s*"create"/.test(t.arguments),
  );
}

/**
 * Combine extraction + the caller's DB lookups into a verdict. `knownIds` /
 * `knownSeqs` are the claim ids that DO exist for this project.
 */
export function judgeIssueClaims(
  claims: IssueClaims,
  known: { ids: ReadonlySet<string>; seqs: ReadonlySet<number> },
  toolCalls: Array<{ name: string; arguments: string }>,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const id of claims.malformedUrlIds) {
    problems.push(`issue link id "${id}" is not a real issue id`);
  }
  for (const id of claims.urlIds) {
    if (!known.ids.has(id)) problems.push(`issue link id "${id}" does not exist in this project`);
  }
  for (const seq of claims.issSeqs) {
    if (!known.seqs.has(seq)) problems.push(`ISS-${seq} does not exist in this project`);
  }
  if (
    claims.claimsCreation &&
    !turnCreatedIssue(toolCalls) &&
    claims.urlIds.length === 0 &&
    claims.issSeqs.length === 0
  ) {
    problems.push('reply claims an issue was created but no forge_issues create call was made');
  }
  return { ok: problems.length === 0, problems };
}
