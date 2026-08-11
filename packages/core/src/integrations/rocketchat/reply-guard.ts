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

/**
 * Kernel guard against a SELF-COUNTED progress figure in bot replies
 * (ISS-671 direction B): the 54-issue incident happened because the model
 * had only `forge_issues.list` (newest-25) to go on, so a wrong figure
 * looked plausible to the model that produced it. This guard cross-validates
 * any completion count or percentage in the reply against the deterministic
 * snapshot (`issues/progress.ts`) injected earlier in the SAME turn — it
 * cannot fix a bad count, only reject it, which is what forces the
 * corrective retry that restates the authoritative numbers.
 *
 * Fail-CLOSED when `facts` is null: the snapshot computation failed, so
 * nothing authoritative was injected this turn — any progress figure in that
 * state can only have been self-counted. This is deliberately STRICTER than
 * `reply-screen.ts`'s documented fail-OPEN carve-out for its own DB lookup:
 * an infra blip there costs one ordinary reply, whereas failing open here
 * would let through exactly the hallucination this guard exists to catch.
 */

export interface ProgressFacts {
  shipped: number;
  closedUnshipped: number;
  inFlight: number;
  remaining: number;
  total: number;
}

const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISS_TOKEN_RE = /\bISS-\d{1,6}\b/gi;
const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

/** Already-guarded citations and timestamps must never register as figures —
 *  strip them before the count/percentage scan ever sees the text. */
function stripNonFigureTokens(reply: string): string {
  return reply.replace(UUID_TOKEN_RE, ' ').replace(ISS_TOKEN_RE, ' ').replace(ISO_DATE_RE, ' ');
}

// cm:why matches the Vietnamese/English "nothing done" phrasing that produced the literal 54-issue incident
const DENIAL_RE =
  // cm:ignore CM001 — i18n-allow: regex literal must contain the Vietnamese denial phrasing being matched
  /chưa\s+(có\s+gì|làm\s+gì|bắt\s+đầu|triển\s+khai)|chưa\s+có\s+tiến\s+độ|chưa\s+hoàn\s+thành\s+(việc|issue)\s+nào|\bnot\s+started\b|\bnothing\s+(has\s+been\s+)?(done|completed)\b|\bno\s+(work|progress)\s+(has\s+been\s+)?(done|made)\b/i; // i18n-allow: matches the Vietnamese/English "nothing done" phrasing under test

const PROGRESS_KEYWORD_RE =
  // cm:ignore CM001 — i18n-allow: regex literal must contain the Vietnamese progress-keyword vocabulary being scanned
  /hoàn thành|hoàn tất|đã xong|đã đóng|còn lại|đang làm|tổng|done|completed|closed|finished|remaining|in progress|total/gi; // i18n-allow: the Vietnamese progress-keyword vocabulary being scanned

// cm:why a number must be DIRECTLY adjacent to a keyword (only whitespace/colon between) — a wide character window flagged ordinary unrelated numbers several words away as if they were claimed counts (AC#6)
const NUMBER_AFTER_KEYWORD_RE = new RegExp(`(${PROGRESS_KEYWORD_RE.source})\\s*:?\\s*(\\d+)`, 'gi');
const NUMBER_BEFORE_KEYWORD_RE = new RegExp(`(\\d+)\\s+(${PROGRESS_KEYWORD_RE.source})`, 'gi');

// cm:why same adjacency requirement as the count rule — an unrelated percentage ("nhanh hơn 20%") must never be read as a progress claim (B1) // i18n-allow: quotes the Vietnamese example phrase being guarded against
const PERCENT_AFTER_KEYWORD_RE = new RegExp(
  `(${PROGRESS_KEYWORD_RE.source})\\s*:?\\s*(\\d{1,3})\\s*%`,
  'gi',
);
const PERCENT_BEFORE_KEYWORD_RE = new RegExp(
  `(\\d{1,3})\\s*%\\s+(${PROGRESS_KEYWORD_RE.source})`,
  'gi',
);

function authoritativeSummary(facts: ProgressFacts): string {
  return `shipped=${facts.shipped}, closed without shipping=${facts.closedUnshipped}, in progress=${facts.inFlight}, not started=${facts.remaining}, total=${facts.total}`;
}

/** Every integer immediately adjacent to a progress keyword (before or
 *  after, only whitespace/colon in between), paired with the keyword that
 *  put it in scope. A number elsewhere in the sentence — even a few words
 *  away — is ordinary prose, not a claimed count. */
function progressContextNumbers(scanText: string): Array<{ n: number; keyword: string }> {
  const found: Array<{ n: number; keyword: string }> = [];
  const isPercent = (numIndex: number, numStr: string): boolean =>
    /^\s*%/.test(scanText.slice(numIndex + numStr.length));
  for (const m of scanText.matchAll(NUMBER_AFTER_KEYWORD_RE)) {
    const [whole, keyword, numStr] = m as unknown as [string, string, string];
    const numIndex = (m.index ?? 0) + whole.length - numStr.length;
    if (isPercent(numIndex, numStr)) continue;
    found.push({ n: Number(numStr), keyword });
  }
  for (const m of scanText.matchAll(NUMBER_BEFORE_KEYWORD_RE)) {
    const [, numStr, keyword] = m as unknown as [string, string, string];
    const numIndex = m.index ?? 0;
    if (isPercent(numIndex, numStr)) continue;
    found.push({ n: Number(numStr), keyword });
  }
  return found;
}

/** Every `N%` immediately adjacent to a progress keyword — same adjacency
 *  rule as {@link progressContextNumbers}, so an unrelated percentage several
 *  words away is ordinary prose, not a progress claim. */
function progressContextPercents(scanText: string): Array<{ pct: number; keyword: string }> {
  const found: Array<{ pct: number; keyword: string }> = [];
  for (const m of scanText.matchAll(PERCENT_AFTER_KEYWORD_RE)) {
    const [, keyword, pctStr] = m as unknown as [string, string, string];
    found.push({ pct: Number(pctStr), keyword });
  }
  for (const m of scanText.matchAll(PERCENT_BEFORE_KEYWORD_RE)) {
    const [, pctStr, keyword] = m as unknown as [string, string, string];
    found.push({ pct: Number(pctStr), keyword });
  }
  return found;
}

/** Legal percentage for each bucket independently (shipped/closedUnshipped/
 *  inFlight/remaining over total) — a claim can legitimately describe any one
 *  of the four ("10% đang làm", "còn 27% chưa xong"), not only shipped/total. // i18n-allow: quotes the Vietnamese example phrases being permitted
 *  `total === 0` makes every bucket's share 0%, so 0% alone is legal. */
function expectedPercents(facts: ProgressFacts): number[] {
  if (facts.total === 0) return [0];
  return [facts.shipped, facts.closedUnshipped, facts.inFlight, facts.remaining].map((n) =>
    Math.round((n / facts.total) * 100),
  );
}

export function checkProgressClaims(reply: string, facts: ProgressFacts | null): ProductLintResult {
  const scanText = stripNonFigureTokens(reply);

  if (facts === null) {
    const numbers = progressContextNumbers(scanText);
    const percents = progressContextPercents(scanText);
    if (numbers.length === 0 && percents.length === 0) return { ok: true, problems: [] };
    return {
      ok: false,
      problems: [
        'reply states a progress figure but the authoritative snapshot could not be computed this turn — do not state any completion count or percentage; say the figures are temporarily unavailable instead',
      ],
    };
  }

  const problems = new Set<string>();

  if ((facts.shipped > 0 || facts.inFlight > 0) && DENIAL_RE.test(scanText)) {
    problems.add(
      `reply claims no work has been done, but authoritative progress is ${authoritativeSummary(facts)} — restate using these figures`,
    );
  }

  const allowedCounts = new Set([
    facts.shipped,
    facts.closedUnshipped,
    facts.inFlight,
    facts.remaining,
    facts.total,
  ]);
  for (const { n, keyword } of progressContextNumbers(scanText)) {
    if (!allowedCounts.has(n)) {
      problems.add(
        `stated "${n}" near "${keyword}" does not match authoritative progress (${authoritativeSummary(facts)}) — restate using these figures`,
      );
    }
  }

  const expectedPcts = expectedPercents(facts);
  for (const { pct, keyword } of progressContextPercents(scanText)) {
    if (!expectedPcts.some((e) => Math.abs(pct - e) <= 1)) {
      problems.add(
        `stated "${pct}%" near "${keyword}" does not match authoritative progress (${authoritativeSummary(facts)}) — restate using these figures`,
      );
    }
  }

  return { ok: problems.size === 0, problems: [...problems] };
}
