/**
 * The rule that screens a stated completion figure against the deterministic
 * snapshot the model was actually shown. Moved out of the adapter tree
 * unchanged; `legacy-verdicts.fixture.json` is the baseline that says so.
 */

// every frozen comment in this file is an `i18n-allow` pragma carrying the Vietnamese phrasing its regex matches; deleting one to pay the drain reds the language gate instead.

import type { MessageRule, RuleBreak } from './contract.js';
import type { ProgressFacts } from './facts.js';

const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISS_TOKEN_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/gi;
const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

function stripNonFigureTokens(reply: string): string {
  return reply.replace(UUID_TOKEN_RE, ' ').replace(ISS_TOKEN_RE, ' ').replace(ISO_DATE_RE, ' ');
}

const DENIAL_RE =
  // i18n-allow: regex literal must contain the Vietnamese denial phrasing being matched
  /chưa\s+(có\s+gì|làm\s+gì|triển\s+khai)|chưa\s+có\s+tiến\s+độ|(?:dự\s+án|công\s+việc|toàn\s+bộ|tất\s+cả)\s+(?:này\s+)?(?:vẫn\s+)?chưa\s+bắt\s+đầu|chưa\s+bắt\s+đầu\s+(?:gì|việc\s+gì)|chưa\s+hoàn\s+thành\s+(việc|issue)\s+nào|\b(?:the\s+|any\s+|no\s+)?(?:work|project|implementation|development|delivery|build|rollout)\s+(?:has\s+|is\s+|have\s+|are\s+)?(?:been\s+)?not\s+(?:yet\s+)?(?:started|begun)\b|\bno\s+work\s+(?:has\s+)?(?:been\s+)?(?:started|begun)\b|\bnothing\s+(?:has\s+)?(?:been\s+)?started\b|\bnot\s+started\s+(?:at\s+all|on\s+anything)\b|\bnothing\s+(has\s+been\s+)?(done|completed)\b|\bno\s+(work|progress)\s+(has\s+been\s+)?(done|made)\b/i; // i18n-allow: matches the Vietnamese/English "nothing done" phrasing under test

const PROGRESS_KEYWORDS =
  // i18n-allow: the literal must contain the Vietnamese progress-keyword vocabulary being scanned
  'hoàn thành|hoàn tất|đã xong|đã đóng|còn lại|đang làm|chưa bắt đầu|tổng|done|completed|closed|finished|remaining|in progress|not started|total'; // i18n-allow: the Vietnamese progress-keyword vocabulary being scanned

const EMPHASIS = '[*_`~]*';

const NUMBER_AFTER_KEYWORD_RE = new RegExp(
  `(${PROGRESS_KEYWORDS})${EMPHASIS}\\s*:?\\s*${EMPHASIS}(\\d+)`,
  'gi',
);
const NUMBER_BEFORE_KEYWORD_RE = new RegExp(
  `(\\d+)${EMPHASIS}\\s+${EMPHASIS}(${PROGRESS_KEYWORDS})`,
  'gi',
);

// // i18n-allow: quotes the Vietnamese example phrase being guarded against
const PERCENT_AFTER_KEYWORD_RE = new RegExp(
  `(${PROGRESS_KEYWORDS})${EMPHASIS}\\s*:?\\s*${EMPHASIS}(\\d{1,3})\\s*%`,
  'gi',
);
const PERCENT_BEFORE_KEYWORD_RE = new RegExp(
  `(\\d{1,3})\\s*%${EMPHASIS}\\s+${EMPHASIS}(${PROGRESS_KEYWORDS})`,
  'gi',
);

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

// // i18n-allow: quotes the Vietnamese example phrases being permitted
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

export const PROGRESS_FIGURES_MATCH: MessageRule = {
  id: 'progress-figures-match',
  shape: 'state only the figures from this turn’s snapshot, or none at all',
  example: 'Most of the work is done and a few items are still open.',
  needs: ['progress'],
  check: (text, f) => judge(text, f.progress),
};
