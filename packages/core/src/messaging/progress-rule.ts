/**
 * The rule that screens a stated completion figure against the deterministic
 * snapshot the model was actually shown. Moved out of the adapter tree
 * unchanged; `legacy-verdicts.fixture.json` is the baseline that says so.
 */

// cm:ignore CM013 — every frozen comment in this file is an `i18n-allow` pragma carrying the Vietnamese phrasing its regex matches; deleting one to pay the drain reds the language gate instead.

import type { MessageRule, RuleBreak } from './contract.js';
import type { ProgressFacts } from './facts.js';

const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISS_TOKEN_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/gi;
const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

function stripNonFigureTokens(reply: string): string {
  return reply.replace(UUID_TOKEN_RE, ' ').replace(ISS_TOKEN_RE, ' ').replace(ISO_DATE_RE, ' ');
}

// cm:why matches the Vietnamese/English "nothing done" phrasing that produced the literal 54-issue incident
// cm:guard every English alternative is TOTALIZING — it needs a subject saying *none of it* — and
// the bare `\bnot started\b` that used to stand among them is gone: `authoritativeSummary` below
// renders `not started=N`, the corrective message hands the model that sentence, and a correct
// summary restating it as "4 not started" was read as a claim that nothing had been done, refused,
// told to restate using those figures, and refused again — unrepairable by construction. Measured
// over beta's 146-turn QA window at 45d92580: 12 replies carried the bare label and NOT ONE carried
// a real denial, so every refusal the alternative produced was a false one. The narrowing is the
// direction this rule's own guard declares — high precision, low recall, because a false refusal
// taxes every agent in the fleet while a missed claim is the state the tracker was already in
// (ISS-1057, codex F4).
const DENIAL_RE =
  // cm:ignore CM001 — i18n-allow: regex literal must contain the Vietnamese denial phrasing being matched
  /chưa\s+(có\s+gì|làm\s+gì|bắt\s+đầu|triển\s+khai)|chưa\s+có\s+tiến\s+độ|chưa\s+hoàn\s+thành\s+(việc|issue)\s+nào|\b(?:no\s+work|nothing|the\s+work|the\s+project|work)\s+(?:has\s+)?(?:been\s+)?not\s+started\b|\bnot\s+started\s+(?:at\s+all|on\s+anything)\b|\bnothing\s+(has\s+been\s+)?(done|completed)\b|\bno\s+(work|progress)\s+(has\s+been\s+)?(done|made)\b/i; // i18n-allow: matches the Vietnamese/English "nothing done" phrasing under test

// cm:guard a plain string, NOT a regex: this is only ever interpolated via the four RegExp constructors below, and a `g`-flagged RegExp object carries mutable `lastIndex` — so anyone who reached for `.test()` on it directly would get position-dependent results
// cm:guard `not started` and its Vietnamese pair are KEYWORDS here, the other half of the same
// defect: `authoritativeSummary` renders the `remaining` bucket under that label, so the model
// states its count in those words — and until this line the count beside it was checked against
// nothing at all, while the phrase itself was read as a denial. It is a figure label, and a figure
// label's number is screened like every other (ISS-1057).
// cm:guard `not started` sits BEFORE `started` would, and no bare `started` is in this list: the
// alternation is scanned left to right, so a shorter alternative that is a suffix of a longer one
// would capture the number first and report the wrong keyword in its refusal.
const PROGRESS_KEYWORDS =
  // cm:ignore CM001 — i18n-allow: the literal must contain the Vietnamese progress-keyword vocabulary being scanned
  'hoàn thành|hoàn tất|đã xong|đã đóng|còn lại|đang làm|chưa bắt đầu|tổng|done|completed|closed|finished|remaining|in progress|not started|total'; // i18n-allow: the Vietnamese progress-keyword vocabulary being scanned

// cm:why a number must be DIRECTLY adjacent to a keyword (only whitespace/colon between) — a wide character window flagged ordinary unrelated numbers several words away as if they were claimed counts (AC#6)
const NUMBER_AFTER_KEYWORD_RE = new RegExp(`(${PROGRESS_KEYWORDS})\\s*:?\\s*(\\d+)`, 'gi');
const NUMBER_BEFORE_KEYWORD_RE = new RegExp(`(\\d+)\\s+(${PROGRESS_KEYWORDS})`, 'gi');

// cm:why same adjacency requirement as the count rule — an unrelated percentage ("nhanh hơn 20%") must never be read as a progress claim (B1) // i18n-allow: quotes the Vietnamese example phrase being guarded against
const PERCENT_AFTER_KEYWORD_RE = new RegExp(
  `(${PROGRESS_KEYWORDS})\\s*:?\\s*(\\d{1,3})\\s*%`,
  'gi',
);
const PERCENT_BEFORE_KEYWORD_RE = new RegExp(`(\\d{1,3})\\s*%\\s+(${PROGRESS_KEYWORDS})`, 'gi');

function authoritativeSummary(f: ProgressFacts): string {
  return `shipped=${f.shipped}, closed without shipping=${f.closedUnshipped}, in progress=${f.inFlight}, not started=${f.remaining}, total=${f.total}`;
}

/** The text a denial is read over: the number-and-keyword spans taken out, nothing else. */
function withoutFigureContexts(scanText: string): string {
  return scanText
    .replace(NUMBER_AFTER_KEYWORD_RE, ' ')
    .replace(NUMBER_BEFORE_KEYWORD_RE, ' ')
    .replace(PERCENT_AFTER_KEYWORD_RE, ' ')
    .replace(PERCENT_BEFORE_KEYWORD_RE, ' ');
}

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
  // cm:why no isPercent check on this loop, unlike the one above: `(\d+)\s+(KW)` cannot match a percentage — `\d+` and `\s+` are greedy with no viable backtrack (a keyword starts with a letter, never `%`), so the char after the digits always begins the whitespace run
  for (const m of scanText.matchAll(NUMBER_BEFORE_KEYWORD_RE)) {
    const [, numStr, keyword] = m as unknown as [string, string, string];
    found.push({ n: Number(numStr), keyword });
  }
  return found;
}

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

// cm:why any ONE of the four buckets may legitimately be the subject ("10% đang làm", "còn 27% chưa xong"), not only shipped/total; total===0 makes every share 0%, so a bare 0% is legal // i18n-allow: quotes the Vietnamese example phrases being permitted
function expectedPercents(f: ProgressFacts): number[] {
  if (f.total === 0) return [0];
  return [f.shipped, f.closedUnshipped, f.inFlight, f.remaining].map((n) =>
    Math.round((n / f.total) * 100),
  );
}

function judge(reply: string, facts: ProgressFacts | null): RuleBreak[] {
  const scanText = stripNonFigureTokens(reply);
  if (facts === null) {
    const numbers = progressContextNumbers(scanText);
    const percents = progressContextPercents(scanText);
    if (numbers.length === 0 && percents.length === 0) return [];
    return [
      {
        quote: null,
        why: 'reply states a progress figure but the authoritative snapshot could not be computed this turn — do not state any completion count or percentage; say the figures are temporarily unavailable instead',
      },
    ];
  }
  const problems = new Map<string, RuleBreak>();
  const add = (why: string, quote: string | null) => {
    if (!problems.has(why)) problems.set(why, { why, quote });
  };
  // cm:guard the denial is read over the text with its FIGURE CONTEXTS removed, so a labelled count
  // is never also a denial: "4 not started" is a figure and is judged as one below, while "the work
  // has not started" survives the removal and still denies. Removing only the matched span and not
  // the sentence is deliberate — "3 completed, but work has not started" keeps its denial
  // (ISS-1057, codex F4).
  const denialText = withoutFigureContexts(scanText);
  if ((facts.shipped > 0 || facts.inFlight > 0) && DENIAL_RE.test(denialText)) {
    add(
      `reply claims no work has been done, but authoritative progress is ${authoritativeSummary(facts)} — restate using these figures`,
      null,
    );
  }
  const allowed = new Set([
    facts.shipped,
    facts.closedUnshipped,
    facts.inFlight,
    facts.remaining,
    facts.total,
  ]);
  for (const { n, keyword } of progressContextNumbers(scanText)) {
    if (!allowed.has(n)) {
      add(
        `stated "${n}" near "${keyword}" does not match authoritative progress (${authoritativeSummary(facts)}) — restate using these figures`,
        `${keyword} ${n}`,
      );
    }
  }
  const expected = expectedPercents(facts);
  for (const { pct, keyword } of progressContextPercents(scanText)) {
    if (!expected.some((e) => Math.abs(pct - e) <= 1)) {
      add(
        `stated "${pct}%" near "${keyword}" does not match authoritative progress (${authoritativeSummary(facts)}) — restate using these figures`,
        `${keyword} ${pct}%`,
      );
    }
  }
  return [...problems.values()];
}

// cm:guard fails CLOSED when the snapshot is null, and only in the cells that carry it — a reader with no role cannot open the tracker to check a figure, so failing open there admits the self-counted number this rule exists to catch (the 54-issue incident, ISS-671).
export const PROGRESS_FIGURES_MATCH: MessageRule = {
  id: 'progress-figures-match',
  shape: 'state only the figures from this turn’s snapshot, or none at all',
  example: 'Most of the work is done and a few items are still open.',
  needs: ['progress'],
  check: (text, f) => judge(text, f.progress),
};
