/**
 * A date or a status a chat reply states about the tracker has to be one this turn's own tool
 * results carry (chat mining 2026-10-07: 12 replies the person contradicted; one gave every
 * completion date as 2024-05-15 with no tool call while the tracker held 2026-07-14/15). The
 * grammar abstains by default, as `status-assertions.ts` does: a construction it does not
 * recognise is passed, because a false refusal costs every reply a rewrite.
 */

import { ISSUE_RESOLVED_STATUSES } from '@forge/contracts/issue-machine';
import { formatIssueRef } from '../lib/issue-ref.js';
import { ISSUES_UNREAD } from './claim-rules.js';
import type { MessageRefusal, MessageVerdict, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';
import { passagesAround } from './figure-sources.js';
import { issueTokenRe } from './issue-tokens.js';

export const GROUNDING_RULE = {
  id: 'tracker-facts-grounded',
  shape:
    'state a date or a status about the tracker only as a tool returned it this turn, and name what the date is of (its key, a release by version) or the read; look it up first, or ask instead of stating it',
  example: 'ISS-59 was closed on 2026-07-15, as the tracker read this turn shows.',
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Words that make a date in the same clause a claim about the tracker. */
const EVENT_RE =
  /\b(created|closed|merged|released|shipped|deployed|opened|filed|completed|finished|updated|due|landed)\b|tạo|đóng|merge|phát hành|triển khai|hoàn thành|cập nhật|hạn chót|xong|ngày/i; // i18n-allow: the Vietnamese event words a tracker date is stated with

/** Where the writer is not asserting: a denial, a condition, a plan or a hedge, in either language. */
const ABSTAIN_RE =
  /\b(not|never|no longer|if|once|unless|until|will|would|could|should|may|might|expected|planned|plan|target|probably|maybe|estimate[ds]?)\b|\bchưa\b|\bkhông\b|\bnếu\b|\bsẽ\b|có thể|dự kiến|ước tính|kế hoạch/i; // i18n-allow: the Vietnamese denial, condition and hedge words

const STATUS_PHRASES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^(?:draft|bản nháp|nháp)\b/i, ['draft']], // i18n-allow: the Vietnamese status names
  [/^(?:in[ _-]progress|đang (?:làm|thực hiện|xử lý))/i, ['in_progress']], // i18n-allow: the Vietnamese status names
  [/^(?:needs[ _-]info|chờ thông tin|cần thêm thông tin)/i, ['needs_info']], // i18n-allow: the Vietnamese status names
  [/^(?:on[ _-]hold|tạm dừng|tạm hoãn)/i, ['on_hold']], // i18n-allow: the Vietnamese status names
  [/^(?:awaiting[ _-]release|chờ phát hành|chờ release)/i, ['awaiting_release']], // i18n-allow: the Vietnamese status names
  [/^(?:approved)\b/i, ['approved']],
  [/^(?:reopen(?:ed)?)\b/i, ['reopen']],
  [/^(?:dropped|đã hủy|đã bỏ|bị bỏ)/i, ['dropped']], // i18n-allow: the Vietnamese status names
  [/^(?:closed|đã đóng)/i, ['closed']], // i18n-allow: the Vietnamese status names
  [/^(?:hoàn thành|đã xong)/i, ISSUE_RESOLVED_STATUSES], // i18n-allow: the Vietnamese status names
  [/^(?:open|đang mở)\b/i, ['open']], // i18n-allow: the Vietnamese status names
];

/** What may stand between an issue key and the status it is said to be at. */
const LINKER_RE =
  /^[\s`*_"'(),]*(?:(?:is|was|are|now|currently|still|at|status|in|đang ở|đang|vẫn|hiện|hiện tại|trạng thái|ở|là)[\s`*_"':,]*){0,4}[:\-–→]?[\s`*_"']*/i; // i18n-allow: the Vietnamese linking words

const CLAUSE_SPLIT_RE = /([.;!?\n]+)/;

function clausesOf(text: string): { text: string; asked: boolean }[] {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/^[ \t]*>.*$/gm, ' ');
  const pieces = plain.split(CLAUSE_SPLIT_RE);
  const out: { text: string; asked: boolean }[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const body = (pieces[i] ?? '').trim();
    if (body) out.push({ text: body, asked: (pieces[i + 1] ?? '').includes('?') });
  }
  return out;
}

interface Day {
  readonly quote: string;
  readonly ms: number;
}

function day(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  return Number.isNaN(ms) ? null : ms;
}

/** Calendar dates written as ISO, as day/month/year, or as the Vietnamese long form. */
export function datesIn(text: string): Day[] {
  const out: Day[] = [];
  const push = (quote: string, ms: number | null) => {
    if (ms !== null) out.push({ quote, ms });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)) {
    push(m[0], day(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    push(m[0], day(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  const longForm = /ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))/gi; // i18n-allow: the Vietnamese date form
  for (const m of text.matchAll(longForm)) {
    push(m[0], day(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  return out;
}

/** A stated date is grounded by a result date within a day of it: a timestamp near midnight reads as either day. */
function grounded(stated: Day, results: readonly Day[]): boolean {
  return results.some((r) => Math.abs(r.ms - stated.ms) <= DAY_MS);
}

/**
 * What names the read a tracker date came from (REQ-30 BC-1): the item it is a date of, by its key
 * (ISS-59, REQ-30, FB-12) or a release by its version, or the read itself by name. An event word is
 * not a source: "released on 2026-10-01" names when, not where it was read.
 */
const DATE_SOURCE_RE =
  /\b[A-Z][A-Z0-9]{1,5}-\d{1,6}\b|\bv?\d+\.\d+(?:\.\d+)?\b|\b(?:project\s+status|status\s+read|tracker|releases?\s+(?:list|page|read)|release\s+v?\d|reports?|decisions?|memory|history|timeline)\b|trạng\s+thái\s+dự\s+án|báo\s+cáo|quyết\s+định/iu; // i18n-allow: the Vietnamese names of the project status, a report and a decision

function dateBreaks(text: string, results: readonly string[]): RuleBreak[] {
  const seen = datesIn(results.join('\n'));
  const breaks: RuleBreak[] = [];
  for (const clause of clausesOf(text)) {
    if (clause.asked || ABSTAIN_RE.test(clause.text) || !EVENT_RE.test(clause.text)) continue;
    for (const stated of datesIn(clause.text)) {
      if (grounded(stated, seen)) {
        const at = text.indexOf(stated.quote);
        const named = passagesAround(text, at < 0 ? 0 : at).some((p) => DATE_SOURCE_RE.test(p));
        if (!named) {
          breaks.push({
            quote: clause.text,
            why: `the reply states the date ${stated.quote} about the tracker and names no read it came from — name the item it is a date of (its key, or the release by version) or the read, in its paragraph, the line that introduces it, or a "Sources:" line`,
          });
        }
        continue;
      }
      breaks.push({
        quote: clause.text,
        why:
          results.length === 0
            ? `the reply states the date ${stated.quote} about the tracker, and this turn read nothing from it — look it up before stating it, or ask`
            : `the reply states the date ${stated.quote} about the tracker, and no tool result this turn carries that date`,
      });
    }
  }
  return breaks;
}

function statusBreaks(text: string, results: readonly string[], f: MessageFacts): RuleBreak[] {
  const read = results.join('\n').toUpperCase();
  const breaks: RuleBreak[] = [];
  const said = new Set<string>();
  for (const clause of clausesOf(text)) {
    if (clause.asked || ABSTAIN_RE.test(clause.text)) continue;
    for (const m of clause.text.matchAll(issueTokenRe(f.prefixes))) {
      const after = clause.text.slice((m.index ?? 0) + m[0].length);
      const linked = LINKER_RE.exec(after);
      const rest = after.slice(linked ? linked[0].length : 0);
      const hit = STATUS_PHRASES.find(([re]) => re.test(rest));
      if (!hit) continue;
      // the rows were not read: a status stated of a named issue cannot be checked, so it is held
      if (f.issueLookupFailed) return [ISSUES_UNREAD];
      const seq = Number(m[2]);
      const row = f.issueRows.get(seq);
      if (!row) continue;
      const ref = formatIssueRef(f.prefix, seq);
      if (said.has(ref)) continue;
      said.add(ref);
      const [, statuses] = hit;
      if (!statuses.includes(row.status)) {
        breaks.push({
          quote: clause.text,
          why: `the reply says ${ref} is ${statuses.join(' or ')}, and the tracker holds ${ref} at ${row.status}`,
        });
      } else if (!read.includes(m[0].toUpperCase())) {
        breaks.push({
          quote: clause.text,
          why: `the reply states ${ref}'s status without reading ${ref} this turn — read it before stating it`,
        });
      }
    }
  }
  return breaks;
}

/** Every date and status the reply states about the tracker that this turn's results do not carry. */
export function ungroundedClaims(
  text: string,
  toolResults: readonly string[],
  f: MessageFacts,
): RuleBreak[] {
  return [...dateBreaks(text, toolResults), ...statusBreaks(text, toolResults, f)];
}

/** The cell's verdict, refused as well where a segment states a tracker fact this turn did not read. */
export function withGrounding(
  verdict: MessageVerdict,
  segments: readonly string[],
  toolResults: readonly string[],
  f: MessageFacts,
): MessageVerdict {
  const refusals: MessageRefusal[] = segments.flatMap((s) =>
    ungroundedClaims(s ?? '', toolResults, f).map((b) => ({
      rule: GROUNDING_RULE.id,
      why: b.why,
      quote: b.quote,
      shape: GROUNDING_RULE.shape,
      example: GROUNDING_RULE.example,
      ...(b.unchecked ? { unchecked: b.unchecked } : {}),
    })),
  );
  if (refusals.length === 0) return verdict;
  return { ok: false, refusals: [...(verdict.ok ? [] : verdict.refusals), ...refusals] };
}
