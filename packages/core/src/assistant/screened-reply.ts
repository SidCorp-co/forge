import {
  CORRECTIVE_PREFIX,
  codeAuthored,
  confidentLanguageOf,
  emptyFallbackReply,
  errorFallbackReply,
  type ReplyLanguage,
  type ScreenedMessage,
  screened,
  unverifiedFallbackReply,
} from '../conversations/index.js';
import { logger } from '../lib/logger.js';
import {
  type DoorId,
  type MessageRefusal,
  type MessageVerdict,
  refusalsOf,
} from '../messaging/contract.js';
import { doorPolicy } from '../messaging/doors.js';
import { datesIn, GROUNDING_RULE } from '../messaging/grounding-rule.js';
import { withRepairs } from '../messaging/repairs.js';
import { markUnverified, repairIssueLinks } from '../messaging/reply-marks.js';
import { screenReplyAtDoor } from '../messaging/reply-screen.js';
import { STATUS_CLAIMS_GROUNDED } from '../messaging/status-claims-rule.js';
import type { ExternalChatTurnResult } from './external-chat.js';

/**
 * What a turn says when it has nothing to add.
 */
const NOTHING_TO_ADD = '(nothing to add)';

/**
 * Did the model decline this turn? Case, punctuation and whatever it added after
 * the sentinel are the model's; the judgement is not.
 */
export function declinedTurn(text: string): boolean {
  return text.trim().toLowerCase().startsWith(NOTHING_TO_ADD);
}

/** What the model wrote after the sentinel, for the log; empty when it wrote nothing more. */
export function declinedTail(text: string): string {
  const trimmed = text.trim();
  return trimmed
    .slice(NOTHING_TO_ADD.length)
    .replace(/^[\s.!—–-]+/, '')
    .trim();
}

const correctiveMessage = (refusals: readonly MessageRefusal[]): string =>
  `${CORRECTIVE_PREFIX} Your previous reply cannot be sent as-is: ${refusals.map((r) => r.why).join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

const LANGUAGE_NAME: Record<ReplyLanguage, string> = { en: 'English', vi: 'Vietnamese' };

/**
 * Hold the reply to the language the person wrote in (content-language `chat`: "Answer the person
 * in the language they wrote in"), and record the judgement on every turn, matched or not, so the
 * rate is read from the log rather than guessed. Only what can be told with confidence is judged.
 */
export function withReplyLanguage(
  verdict: MessageVerdict,
  reply: string,
  asked: ReplyLanguage | null,
  log?: Record<string, unknown>,
): MessageVerdict {
  const replied = confidentLanguageOf(reply);
  const match = asked && replied ? asked === replied : null;
  logger.info({ ...log, asked, replied, match }, 'conversations: reply language');
  if (match !== false || !asked || !replied) return verdict;
  const refusal: MessageRefusal = {
    rule: 'reply-language',
    why: `the person wrote in ${LANGUAGE_NAME[asked]} and the reply is in ${LANGUAGE_NAME[replied]}`,
    quote: null,
    shape: 'answer in the language the person wrote in',
    example: asked === 'vi' ? 'ISS-61 đang chờ phát hành.' : 'ISS-61 is awaiting release.', // i18n-allow: the example a Vietnamese asker is answered with
  };
  return { ok: false, refusals: [...(verdict.ok ? [] : verdict.refusals), refusal] };
}

const EMPTY_RETRY = {
  rule: 'non-empty',
  why: 'empty retry reply',
  quote: null,
  shape: 'the rewrite carries text',
  example: 'The deploy is done; one check is still red.',
} as const;

const REWRITE_RULE = {
  rule: 'rewrite-keeps-claims',
  shape:
    'a rewrite corrects what was refused and keeps every other claim as the answer it rewrites made it',
  example: 'The oldest is ISS-61, created on 2026-07-14, as the first answer said.',
} as const;

const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;

const keysIn = (text: string): Set<string> => new Set(text.match(ISSUE_KEY_RE) ?? []);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rules whose refusal is about which issue a claim names, or what it holds. */
const ISSUE_CLAIM_RULES: ReadonlySet<string> = new Set([
  'issue-keys-exist',
  'status-matches-the-row',
]);

/**
 * What kind of claim a refusal was about: the date one stated, the issue one named, a status claim
 * that has to be read and restated (`status-claims-rule.ts`, which may bring either), or neither.
 */
function claimRefused(r: MessageRefusal): 'date' | 'issue' | 'status' | null {
  if (r.rule === STATUS_CLAIMS_GROUNDED.id) return 'status';
  if (ISSUE_CLAIM_RULES.has(r.rule)) return 'issue';
  if (r.rule !== GROUNDING_RULE.id) return null;
  return r.why.includes('states the date') ? 'date' : 'issue';
}

/**
 * Hold a rewrite to the answer it rewrites: an issue it names or a date it states that the first
 * answer did not is a new claim, admitted only where the first answer had a claim of that kind
 * refused AND this turn's tool results carry it. A rewrite exists to correct what was refused;
 * anything else it changes is a claim nothing checked (QA 2026-10-07: a true "oldest is ISS-261"
 * was refused for its link and rewritten as a false "oldest is ISS-299").
 */
export function withRewriteKept(
  verdict: MessageVerdict,
  args: {
    original: string;
    refused: readonly MessageRefusal[];
    rewrite: string;
    toolResults: readonly string[];
  },
): MessageVerdict {
  const read = args.toolResults.join('\n');
  const kinds = new Set(args.refused.map(claimRefused));
  const keyRefused = kinds.has('issue') || kinds.has('status');
  const dateRefused = kinds.has('date') || kinds.has('status');
  const before = keysIn(args.original);
  const breaks: MessageRefusal[] = [];
  const refuse = (quote: string, why: string) => breaks.push({ ...REWRITE_RULE, quote, why });
  for (const key of keysIn(args.rewrite)) {
    if (before.has(key)) continue;
    if (!keyRefused) {
      refuse(
        key,
        `the rewrite names ${key}, which the answer it rewrites did not name, and nothing refused in that answer was about an issue — a rewrite may not state a new claim`,
      );
    } else if (!read.toUpperCase().includes(key)) {
      refuse(key, `the rewrite names ${key}, which no tool result this turn carries`);
    }
  }
  const beforeDays = datesIn(args.original).map((d) => d.ms);
  const readDays = datesIn(read).map((d) => d.ms);
  const near = (days: readonly number[], ms: number) =>
    days.some((d) => Math.abs(d - ms) <= DAY_MS);
  for (const day of datesIn(args.rewrite)) {
    if (near(beforeDays, day.ms)) continue;
    if (!dateRefused) {
      refuse(
        day.quote,
        `the rewrite states the date ${day.quote}, which the answer it rewrites did not, and nothing refused in that answer was a date — a rewrite may not state a new claim`,
      );
    } else if (!near(readDays, day.ms)) {
      refuse(
        day.quote,
        `the rewrite states the date ${day.quote}, which no tool result this turn carries`,
      );
    }
  }
  if (breaks.length === 0) return verdict;
  return { ok: false, refusals: [...refusalsOf(verdict), ...breaks] };
}

/** The refusals marking cannot carry: there is no claim in them to mark, only a message that may not go out. */
const UNMARKABLE: ReadonlySet<string> = new Set([
  'non-empty',
  'no-redacted-secret',
  'no-empty-promise',
]);

/**
 * The first answer with each claim its screen refused marked unverified, or null where a refusal
 * names no claim that can be found and marked. A refusal of its language marks nothing: the answer
 * is true, only in the other language.
 */
export function markedOriginal(
  original: string,
  refused: readonly MessageRefusal[],
  language: ReplyLanguage,
): string | null {
  const claims = refused.filter((r) => r.rule !== 'reply-language');
  if (claims.some((r) => UNMARKABLE.has(r.rule) || r.quote === null)) return null;
  return markUnverified(
    original,
    claims.map((r) => r.quote as string),
    language,
  );
}

export interface ScreenedTurnArgs {
  /** The door this reply goes out of; its row carries the pair and the repair budget. */
  door: DoorId;
  projectId: string;
  /** The answering handle's own name — the fallbacks speak as it. */
  handleName: string;
  /** The language the fallbacks answer in. */
  language: ReplyLanguage;
  /** The first attempt, already run. */
  first: ExternalChatTurnResult;
  /** The tools the turn was offered, by the names it calls them: a status claim is held to a read only where one was offered. */
  offeredTools?: readonly string[];
  /** Ask the model again with a corrective instruction, and hand back what it wrote. */
  retry: (instruction: string) => Promise<ExternalChatTurnResult>;
  setPhase: (phase: string) => void;
  /** What stands when the screen is exhausted or the model wrote nothing: a code-authored line, or nothing at all. */
  fallback?: 'code-authored' | 'none';
  /** What this turn's tools returned so far; a tracker date or status the reply states is held to it. */
  toolResults?: () => readonly string[];
  /** The language the person wrote in, where it can be told; the reply is held to it. */
  askedIn?: ReplyLanguage | null;
  /** What the person asked: a figure the reply states is held to the turn's report runs, and a number they typed may be said back. */
  question?: string;
  /**
   * The code-authored report of an attempt the provider broke off: what the turn did and found, in
   * the asker's language. Absent, the generic error line stands.
   */
  brokenReport?: (attempt: ExternalChatTurnResult) => string;
  log?: Record<string, unknown>;
}

/**
 * Refuse a door that owes nobody a reply, before a turn is spent on one.
 */
export function assertAnswerableDoor(door: DoorId): void {
  if (doorPolicy(door).ending === 'fallback') return;
  throw new Error(
    `conversations: the turn runner answers somebody who is waiting, so it needs a door whose ending is "fallback"; "${door}" ends in a refusal and owes no reply at all`,
  );
}

/**
 * Screen a model turn's reply, and return the text that may be sent.
 *
 * An issue link written as a hash route is pointed at the path the web serves before anything is
 * judged. A refused answer is rewritten within the door's budget, and the rewrite is held to the
 * same screen and to the answer it rewrites. Where no rewrite passes, the first answer goes out with
 * its refused claims marked unverified if that passes the screen; never a claim nothing checked.
 */
export async function screenedTurnReply(args: ScreenedTurnArgs): Promise<ScreenedMessage | null> {
  assertAnswerableDoor(args.door);
  let result = args.first;
  let attempt = 0;
  let broken: ExternalChatTurnResult | null = null;
  const original = repairIssueLinks(args.first.reply).trim();
  let firstRefused: readonly MessageRefusal[] = [];
  args.setPhase('verify');

  const judge = async (
    text: string,
    of: ExternalChatTurnResult,
    language: boolean,
  ): Promise<MessageVerdict> => {
    const verdict = await screenReplyAtDoor(args.door, {
      projectId: args.projectId,
      segments: [text],
      toolCalls: of.toolCalls,
      ...(args.offeredTools ? { offeredTools: args.offeredTools } : {}),
      progress: of.progress,
      ...(args.toolResults ? { toolResults: args.toolResults() } : {}),
      ...(args.question !== undefined ? { question: args.question } : {}),
    });
    return language ? withReplyLanguage(verdict, text, args.askedIn ?? null, args.log) : verdict;
  };

  const outcome = await withRepairs(args.door, [original], {
    screen: async (segments): Promise<MessageVerdict> => {
      const text = (segments[0] ?? '').trim();
      if (!text) {
        return attempt === 0
          ? ({ ok: true } as MessageVerdict)
          : { ok: false, refusals: [EMPTY_RETRY] };
      }
      const verdict = await judge(text, result, true);
      if (attempt === 0) {
        firstRefused = refusalsOf(verdict);
        return verdict;
      }
      return withRewriteKept(verdict, {
        original,
        refused: firstRefused,
        rewrite: text,
        toolResults: args.toolResults?.() ?? [],
      });
    },
    rewrite: async (verdict) => {
      attempt += 1;
      logger.warn(
        { ...args.log, refusals: refusalsOf(verdict) },
        'conversations: reply failed its door screen; corrective retry',
      );
      args.setPhase('retry');
      result = await args.retry(correctiveMessage(refusalsOf(verdict)));
      if (result.terminal === 'error' && !result.reply.trim()) broken = result;
      return [repairIssueLinks(result.reply)];
    },
  });

  if (outcome.kind === 'exhausted') {
    const marked = markedOriginal(original, firstRefused, args.askedIn ?? args.language);
    if (marked !== null) {
      const verdict = await judge(marked, args.first, false);
      const admitted = verdict.ok ? screened(marked, args.door, verdict) : null;
      if (admitted) {
        logger.warn(
          { ...args.log, refusals: firstRefused },
          'conversations: no rewrite passed; the first answer goes out with its refused claims marked unverified',
        );
        return admitted;
      }
    }
    logger.error(
      { ...args.log, refusals: refusalsOf(outcome.verdict) },
      'conversations: reply still failing its door screen; sending honest fallback',
    );
    if (args.fallback === 'none') return null;
    if (broken && args.brokenReport) return codeAuthored(args.brokenReport(broken));
    return codeAuthored(unverifiedFallbackReply(args.handleName, args.language));
  }

  const trimmed = repairIssueLinks(result.reply).trim();
  if (!trimmed) {
    if (args.fallback === 'none') return null;
    if (result.terminal === 'error' && args.brokenReport) {
      return codeAuthored(args.brokenReport(result));
    }
    return codeAuthored(
      result.terminal === 'error'
        ? errorFallbackReply(args.handleName, args.language)
        : emptyFallbackReply(args.handleName, args.language),
    );
  }
  const passed = screened(trimmed, args.door, outcome.verdict);
  if (!passed) throw new Error('conversations: a passing verdict yielded no screened message');
  return passed;
}
