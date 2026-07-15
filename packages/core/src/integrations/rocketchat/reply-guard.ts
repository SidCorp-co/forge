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

/**
 * Kernel guard against LEAKED DEVELOPER DETAIL in bot replies to non-technical
 * stakeholders (kernel-hard, policy-soft; ISS-671/672): the persona already
 * asks for a plain-language answer, but a weak model can still echo a code
 * fence, a `path:line` reference, a raw pipeline status token, or a bare
 * ISS-id the user has no way to interpret. Pure string analysis — no db/env
 * imports — so it unit-tests standalone.
 */

export interface ProductLintResult {
  ok: boolean;
  problems: string[];
}

const CODE_FENCE_RE = /```/;

const PATH_LINE_RE = /(?:^|\s)[\w./-]*[\w-]\.[a-z]{1,5}:\d+\b/i;

// Deliberately narrow to unambiguous Forge jargon that never appears in
// ordinary Vietnamese/English chat prose — common dictionary words
// (open/testing/tested/closed/approved/waiting/confirmed/draft/released)
// are excluded to avoid retry-looping on legitimate prose (plan unknown:
// heuristic token set, code/review may widen or narrow).
const STATUS_ENUM_RE = /\b(needs_info|in_progress|on_hold|clarified|reopen|developed)\b/i;

const ISS_ID_RE = /\bISS-(\d{1,6})\b/g;

/**
 * Reject reply text a non-technical stakeholder can't act on: code fences,
 * `path:line` references, raw pipeline-status jargon, and bare `ISS-<n>`
 * citations that were NOT already verified as real by `verifyReplyClaims`
 * (that guard's verified set is deliberately carved out here so a normal,
 * already-checked issue citation is never bounced into a retry loop).
 */
export function lintStakeholderReply(
  reply: string,
  opts: { verifiedSeqs: ReadonlySet<number>; skipIssueIdRule?: boolean },
): ProductLintResult {
  const problems: string[] = [];
  if (CODE_FENCE_RE.test(reply)) {
    problems.push(
      'reply contains a code block — rephrase for a non-technical stakeholder: no code, file paths, status codes, or issue ids',
    );
  }
  const pathMatch = reply.match(PATH_LINE_RE);
  if (pathMatch) {
    problems.push(
      `reply exposes developer detail (\`${pathMatch[0].trim()}\`) — rephrase for a non-technical stakeholder: no code, file paths, status codes, or issue ids`,
    );
  }
  const statusMatch = reply.match(STATUS_ENUM_RE);
  if (statusMatch) {
    problems.push(
      `reply leaks a raw pipeline status ("${statusMatch[0]}") — rephrase for a non-technical stakeholder: describe progress in plain language instead`,
    );
  }
  if (!opts.skipIssueIdRule) {
    for (const m of reply.matchAll(ISS_ID_RE)) {
      const seq = Number(m[1]);
      if (!opts.verifiedSeqs.has(seq)) {
        problems.push(
          `reply cites "ISS-${seq}" which was not verified this turn — rephrase for a non-technical stakeholder: no code, file paths, status codes, or issue ids`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// Future-action-without-result phrasing (VN + EN) — the kernel enforcement
// of the persona's existing soft ban on "announce, don't answer" replies.
// No \b wrapping: JS's non-unicode \b treats accented Vietnamese letters as
// non-word characters, so a boundary right before those phrase-initial words
// never matches — the internal `\s+` between phrase words already delimits
// each alternative. // i18n-allow: refers to the Vietnamese phrase words above
const EMPTY_PROMISE_RE =
  /sẽ\s+(kiểm tra|phản hồi|báo(\s+lại)?|cập nhật|xem)|đang\s+(kiểm tra|xử lý)|để\s+(mình|tôi)\s+(kiểm tra|xem)|chờ\s+(mình|tôi)|\bI('?ll| will)\s+(check|look into|get back|investigate)\b|\bget back to you\b/i; // i18n-allow: matches the Vietnamese/English "future promise, no result" phrasing being policed

/**
 * Reject a reply that promises future work with no result attached — there is
 * no follow-up turn, so a promise alone leaves the stakeholder with nothing.
 */
export function detectEmptyPromise(reply: string): ProductLintResult {
  if (!EMPTY_PROMISE_RE.test(reply)) return { ok: true, problems: [] };
  return {
    ok: false,
    problems: [
      'reply promises a future action but there is no follow-up turn — do the work now and report the result, or state exactly what is missing',
    ],
  };
}
