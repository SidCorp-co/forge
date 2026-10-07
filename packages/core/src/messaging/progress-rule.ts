/**
 * The rule that screens a stated issue-progress figure against the deterministic snapshot the
 * model was actually shown. Only a figure that counts issues is a progress claim: a figure bound to
 * another unit (products, rows, pages) is the reply's own subject and is never judged, and a figure
 * is read whole in either thousands notation, so `1.061` and `1,061` are both one thousand and
 * sixty-one.
 */

// every frozen comment in this file is an `i18n-allow` pragma carrying the Vietnamese phrasing its regex matches; deleting one to pay the drain reds the language gate instead.

import type { MessageRule, RuleBreak } from './contract.js';
import type { ProgressFacts } from './facts.js';

const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISS_TOKEN_RE = /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b/gi;
const ISO_DATE_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const blank = (m: string): string => ' '.repeat(m.length);

/** The reply with ids and dates blanked in place, so every offset still points into the reply. */
function stripNonFigureTokens(reply: string): string {
  return reply
    .replace(UUID_TOKEN_RE, blank)
    .replace(ISS_TOKEN_RE, blank)
    .replace(ISO_DATE_RE, blank);
}

const DENIAL_RE =
  // i18n-allow: regex literal must contain the Vietnamese denial phrasing being matched
  /chưa\s+(có\s+gì|làm\s+gì|triển\s+khai)|chưa\s+có\s+tiến\s+độ|(?:dự\s+án|công\s+việc|toàn\s+bộ|tất\s+cả)\s+(?:này\s+)?(?:vẫn\s+)?chưa\s+bắt\s+đầu|chưa\s+bắt\s+đầu\s+(?:gì|việc\s+gì)|chưa\s+hoàn\s+thành\s+(việc|issue)\s+nào|\b(?:the\s+|any\s+|no\s+)?(?:work|project|implementation|development|delivery|build|rollout)\s+(?:has\s+|is\s+|have\s+|are\s+)?(?:been\s+)?not\s+(?:yet\s+)?(?:started|begun)\b|\bno\s+work\s+(?:has\s+)?(?:been\s+)?(?:started|begun)\b|\bnothing\s+(?:has\s+)?(?:been\s+)?started\b|\bnot\s+started\s+(?:at\s+all|on\s+anything)\b|\bnothing\s+(has\s+been\s+)?(done|completed)\b|\bno\s+(work|progress)\s+(has\s+been\s+)?(done|made)\b/i; // i18n-allow: matches the Vietnamese/English "nothing done" phrasing under test

const PROGRESS_KEYWORDS =
  // i18n-allow: the literal must contain the Vietnamese progress-keyword vocabulary being scanned
  'hoàn thành|hoàn tất|đã xong|đã đóng|còn lại|đang làm|chưa bắt đầu|tổng|done|completed|closed|finished|remaining|in progress|not started|total'; // i18n-allow: the Vietnamese progress-keyword vocabulary being scanned

const EMPHASIS = '[*_`~]*';

const NUMBER = '(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{3})+(?!\\d|[.,]\\d)|\\d+)';

const ISSUE_NOUNS =
  // i18n-allow: the literal must contain the Vietnamese nouns that count issues
  'issues?|tickets?|tasks?|đầu\\s+việc|công\\s+việc|việc|hạng\\s+mục|yêu\\s+cầu'; // i18n-allow: the Vietnamese nouns that count issues

const LINKS =
  // i18n-allow: the literal must contain the Vietnamese auxiliaries that join a count to its state
  '(?:(?:đã|đang|chưa|được|vẫn|are|is|were|was|have\\s+been|has\\s+been|have|has)\\s+)*'; // i18n-allow: the Vietnamese auxiliaries that join a count to its state

const NUMBER_AFTER_KEYWORD_RE = new RegExp(
  `(${PROGRESS_KEYWORDS})${EMPHASIS}\\s*:?\\s*${EMPHASIS}${NUMBER}`,
  'gi',
);
const NUMBER_BEFORE_KEYWORD_RE = new RegExp(
  `${NUMBER}${EMPHASIS}\\s+${EMPHASIS}(?:(?:${ISSUE_NOUNS})${EMPHASIS}\\s+${LINKS})?(${PROGRESS_KEYWORDS})`,
  'gi',
);

const ISSUE_NOUN_AHEAD_RE = new RegExp(
  `^${EMPHASIS}\\s*(?:${ISSUE_NOUNS})(?![\\p{L}\\p{N}])`,
  'iu',
);
const WORD_AHEAD_RE = new RegExp(`^${EMPHASIS}[ \\t]*${EMPHASIS}\\p{L}`, 'u');

/** `1.061`, `1,061` and `1061` are the same figure; a separator only ever groups thousands here. */
const figure = (digits: string): number => Number(digits.replace(/[.,]/g, ''));

/** `/11`, ` of 11`: the denominator of a fraction, whose noun is what the fraction counts. */
const DENOMINATOR_AHEAD_RE = new RegExp(`^${EMPHASIS}\\s*(?:\\/|of\\s)\\s*\\d+`, 'i');

/**
 * Whether the figure ending at `end` counts issues: it is followed by an issue noun, or by no word
 * at all. A figure followed by any other word counts that word (`366 products`), and is not a claim
 * about the project's progress; a fraction counts the noun after its denominator (`9/11 criteria`).
 */
function countsIssues(scanText: string, end: number): boolean {
  const ahead = scanText.slice(end, end + 60);
  const after = ahead.replace(DENOMINATOR_AHEAD_RE, '').slice(0, 40);
  if (ISSUE_NOUN_AHEAD_RE.test(after)) return true;
  return !WORD_AHEAD_RE.test(after);
}

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

interface FigureClaim {
  readonly n: number;
  readonly keyword: string;
  /** The claim as the reply wrote it, for the refusal to quote back. */
  readonly claim: string;
}

/** Every figure the reply states about how many issues sit in a progress state. */
function progressContextNumbers(reply: string, scanText: string): FigureClaim[] {
  const found: FigureClaim[] = [];
  const spoken = (m: RegExpMatchArray): string => {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    const closing = /^[*_`~]*/.exec(reply.slice(end))?.[0].length ?? 0;
    return reply.slice(at, end + closing).trim();
  };
  for (const m of scanText.matchAll(NUMBER_AFTER_KEYWORD_RE)) {
    const [whole, keyword, numStr] = m as unknown as [string, string, string];
    const end = (m.index ?? 0) + whole.length;
    if (/^\s*%/.test(scanText.slice(end))) continue;
    if (!countsIssues(scanText, end)) continue;
    found.push({ n: figure(numStr), keyword, claim: spoken(m) });
  }
  for (const m of scanText.matchAll(NUMBER_BEFORE_KEYWORD_RE)) {
    const [, numStr, keyword] = m as unknown as [string, string, string];
    found.push({ n: figure(numStr), keyword, claim: spoken(m) });
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

/** A JSON number a read returned under a key: `"awaitingRelease":26`, `"releaseCount": 64`. */
const JSON_COUNT_RE = /"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*(\d{1,7})(?![\d.])/g;

/** Every count this turn's reads returned as a JSON value, so a figure one of them carries is a read figure. */
export function countsRead(texts: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const t of texts) for (const m of t.matchAll(JSON_COUNT_RE)) out.add(Number(m[1]));
  return out;
}

function judge(
  reply: string,
  facts: ProgressFacts | null,
  read: ReadonlySet<number> = new Set(),
): RuleBreak[] {
  const scanText = stripNonFigureTokens(reply);
  if (facts === null) {
    const numbers = progressContextNumbers(reply, scanText).filter(({ n }) => !read.has(n));
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
  for (const { n, keyword, claim } of progressContextNumbers(reply, scanText)) {
    if (!allowed.has(n) && !read.has(n)) {
      add(
        `the claim "${claim}" states ${n} issues ${keyword}, and no figure in this turn's progress snapshot is ${n} (${authoritativeSummary(facts)}) — restate it from these figures, or leave the figure out`,
        claim,
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
  check: (text, f) => judge(text, f.progress, f.readCounts),
};
