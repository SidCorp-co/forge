// `act_on_decisions`: the chat assistant makes the Needs-you decisions the conversation agreed, as the
// person and with their own access, when their current message tells it to (REQ-41 BC-25). Dev,
// 2026-10-22: the owner agreed a cluster of drafts, said (in Vietnamese) "OK, open that cluster for me"
// and then "I said open them for me", and twice heard "I cannot press approval for you". Core checks the word, not
// the model: the call quotes the person's instruction, and is refused by name unless that quote is
// in their latest message. Only a decision answered by a question's own answer route is made here;
// any other act is refused by name and its card stays. Every item is read back after the act, and
// an item that needed no act is named done with who moved it and when (BC-24, BC-27).
//
// Judge K66 on dev.304 (ISS-624): core, not the prompt, holds the agreed set. A decision is made only
// where the reply the person answered or their latest message names it, so a set the model widens is
// refused item by item (DECISION_NOT_AGREED). An item tried and refused twice in the conversation,
// from chat or from its card, is refused a third time with the defect filed (BC-28). Each result
// carries the sentence core writes for it, which the reply relays as written.

import {
  CHAT_DECIDE_TOOL,
  type ChatDecideRefusalCode,
  type ChatDecisionRefusalCode,
  type ChatDecisionResult,
  chatDecideParamsSchema,
} from '@forge/contracts/chat-decide';
import type { DecisionAnswer, NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { z } from 'zod';
import { isRefusal } from '../../lib/refusal.js';
import { answerAs } from '../../questions/index.js';
import type { ChatFailure } from '../agreement/refused-twice.js';
import { DECISION_TRIES_ALLOWED, keysNamedIn } from '../decision-memory.js';
import { type ItemKind, itemKindOf, itemStateOf, stateSentence } from '../item-state.js';
import { type ChatToolset, thrownMessage, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Make the Needs-you decisions this conversation agreed, as the person and with their own access, when their CURRENT message tells you to (e.g. "open them for me", "mở giúp tôi đi").', // i18n-allow: the Vietnamese instruction the model must recognise
  'word: their instruction, quoted exactly from their latest message; the call is refused unless it is there.',
  'decisions: exactly the decisions agreed, each by its forge_needs_you id or the key it opens (ISS-603), with answer (an answer id; left out, the recommended one) and reason where the answer takes one. Never add one they did not agree to.',
  'Only a decision your reply named (by its key, a key range or its id) or their latest message names is made; any other is refused as not agreed.',
  'Each result is read back with the sentence core wrote for it, in said: relay every said line as written.',
  'Without their word in this message, do not call it: the decision cards under your reply are theirs to press.',
].join(' ');

/** The decisions waiting on a person in a project, as their Needs-you page reads them, with their own access. */
export type NeedsYouDecisionRead = (
  projectId: string,
  userId: string,
) => Promise<readonly NeedsYouDecision[]>;

let decisionsOf: NeedsYouDecisionRead | null = null;

/** Wired at the composition root: the development module's Needs-you read, which this domain may not import. */
export function provideNeedsYouDecisionRead(read: NeedsYouDecisionRead): void {
  decisionsOf = read;
}

/** The decisions waiting on a person now, as their Needs-you page reads them. */
export function readDecisions(
  projectId: string,
  userId: string,
): Promise<readonly NeedsYouDecision[]> {
  if (!decisionsOf) {
    throw new Error(
      'act_on_decisions: no Needs-you read was provided, so no decision can be found to make; index.ts wires provideNeedsYouDecisionRead',
    );
  }
  return decisionsOf(projectId, userId);
}

const QUESTION_PATH = /^\/api\/questions\/([0-9a-f-]{36})\/answer$/;

const refused = (code: ChatDecideRefusalCode, text: string) =>
  toolError(`${code}: ${text} No decision was made.`);

/** The words as compared: case, quotes, dashes and runs of space do not tell two quotes apart. */
const comparable = (text: string): string =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[“”"'‘’`]/g, '')
    .replace(/[\s ]+/g, ' ')
    .trim();

/** Whether the person's latest message holds `word`, and it holds a letter: a quote of nothing is no word. */
export function saidInMessage(word: string, latest: string): boolean {
  const quoted = comparable(word);
  return /\p{L}/u.test(quoted) && comparable(latest).includes(quoted);
}

/** The decisions `target` names: by id, by the row's key, or by the record it opens. */
function matching(decisions: readonly NeedsYouDecision[], target: string): NeedsYouDecision[] {
  const t = target.toUpperCase();
  const byId = decisions.filter((d) => d.id === target);
  if (byId.length > 0) return byId;
  return decisions.filter((d) => d.key.toUpperCase() === t || d.opens?.key.toUpperCase() === t);
}

/** The item a decision or a bare key reads back as, where it is one whose moves are kept. */
function itemOf(
  d: NeedsYouDecision | null,
  target: string,
): { kind: ItemKind; key: string } | null {
  const opens = d?.opens;
  if (
    opens &&
    (opens.kind === 'issue' || opens.kind === 'requirement' || opens.kind === 'feedback')
  ) {
    return { kind: opens.kind, key: opens.key };
  }
  const kind = itemKindOf(target);
  return kind ? { kind, key: target } : null;
}

/** The body an answer posts, with the reason under the field its route reads (`needs-you/api.ts:pressBody`). */
function bodyOf(a: DecisionAnswer, reason: string | undefined): Record<string, unknown> {
  const body = { ...(a.body ?? {}) };
  if (a.needsReason && reason) body['optionId' in body ? 'note' : 'text'] = reason;
  return body;
}

interface Scope {
  projectId: string;
  userId: string;
  /** The person's latest message in this conversation: the word an act stands on. */
  latestMessage: () => string;
  /** The reply the person's latest message answers: with it, what names the set they agreed. */
  answeredReply: () => Promise<string>;
  /** Every decision tried and refused in this conversation, from chat or a card, by item key. */
  failures: () => Promise<ReadonlyMap<string, readonly ChatFailure[]>>;
  /** Files an item tried and refused too often as a defect; the sentence the model is told. */
  fileDefect: (key: string, failures: readonly ChatFailure[]) => Promise<string>;
}

/** What the person agreed: the item keys and decision ids the reply they answered and their message name. */
interface Agreed {
  keys: ReadonlySet<string>;
  text: string;
}

const agreedTo = (agreed: Agreed, d: NeedsYouDecision): boolean =>
  agreed.keys.has(d.key.toUpperCase()) ||
  (d.opens !== null && agreed.keys.has(d.opens.key.toUpperCase())) ||
  agreed.text.includes(d.id.toUpperCase()) ||
  // a key that is no KEY-n (a workflow's flow) is agreed where it is named as written
  new RegExp(
    `(^|[^\\w-])${d.key.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`,
  ).test(agreed.text);

/** A result before core writes its sentence, one variant at a time. */
type Unsaid = ChatDecisionResult extends infer R
  ? R extends unknown
    ? Omit<R, 'said'>
    : never
  : never;

/** The sentence core writes for one result. */
function saidOf(r: Unsaid): string {
  const read = r.state ? ` ${stateSentence(r.state)}` : '';
  if (r.outcome === 'done') return `${r.answer} on ${r.state?.key ?? r.decision}: done.${read}`;
  if (r.outcome === 'already_done')
    return `${r.state.key} needed nothing: it was already done.${read}`;
  return `${r.decision} was not changed: ${r.detail}${read}`;
}

const withSaid = (r: Unsaid): ChatDecisionResult =>
  ({ ...r, said: saidOf(r) }) as ChatDecisionResult;

async function decideOne(
  scope: Scope,
  decisions: readonly NeedsYouDecision[],
  agreed: Agreed,
  failures: ReadonlyMap<string, readonly ChatFailure[]>,
  item: { decision: string; answer?: string | undefined; reason?: string | undefined },
): Promise<ChatDecisionResult> {
  return withSaid(await decided(scope, decisions, agreed, failures, item));
}

async function decided(
  scope: Scope,
  decisions: readonly NeedsYouDecision[],
  agreed: Agreed,
  failures: ReadonlyMap<string, readonly ChatFailure[]>,
  item: { decision: string; answer?: string | undefined; reason?: string | undefined },
): Promise<Unsaid> {
  const target = item.decision;
  const no = (
    code: ChatDecisionRefusalCode,
    detail: string,
    state = null as ChatDecisionResult['state'],
  ) => ({ outcome: 'refused', decision: target, code, detail, state }) as const;
  const found = matching(decisions, target);
  if (found.length > 1) {
    return no(
      'DECISION_AMBIGUOUS',
      `${target} names ${found.length} decisions waiting on the person (${found.map((d) => d.id).join(', ')}); name the one agreed by its id.`,
    );
  }
  const d = found[0] ?? null;
  const item_ = itemOf(d, target);
  if (!d) {
    const state = item_ ? await itemStateOf(scope.projectId, item_) : null;
    if (state) return { outcome: 'already_done', decision: target, state };
    return no(
      'DECISION_UNKNOWN',
      `${target} names no decision waiting on the person and no item of this project.`,
    );
  }
  if (!agreedTo(agreed, d)) {
    return no(
      'DECISION_NOT_AGREED',
      `${d.opens?.key ?? d.key} is named in neither the person's latest message nor the reply they answered, so it is not in the set they agreed; ask them before acting on it.`,
    );
  }
  const onKey = (d.opens?.key ?? d.key).toUpperCase();
  const tried = failures.get(onKey) ?? [];
  if (tried.length >= DECISION_TRIES_ALLOWED) {
    const told = await scope.fileDefect(onKey, tried);
    return no(
      'DECISION_REFUSED_TWICE',
      `${onKey} was tried ${tried.length} times in this conversation and each was refused (${tried.map((f) => f.code).join(', ')}); a third try would fail the same way, so none was made. ${told}`,
      item_ ? await itemStateOf(scope.projectId, item_) : null,
    );
  }
  const answerId = item.answer ?? d.recommended?.answerId;
  if (!answerId) {
    return no(
      'DECISION_NO_RECOMMENDATION',
      `${d.id} recommends no answer (${d.noRecommendation ?? 'none given'}); ask the person which of ${d.answers.map((a) => a.id).join(', ')} they mean.`,
    );
  }
  const answer = d.answers.find((a) => a.id === answerId);
  if (!answer) {
    return no(
      'DECISION_ANSWER_UNKNOWN',
      `${d.id} has no answer ${answerId}; its answers are ${d.answers.map((a) => a.id).join(', ')}.`,
    );
  }
  const question = QUESTION_PATH.exec(answer.path)?.[1];
  if (answer.act !== 'question.answer' || !question) {
    return no(
      'DECISION_ACT_ON_ITS_PAGE',
      `${d.id} is a ${answer.act} decision, made on its card or its page by the person; only a question's answer is made from chat. Its card stays.`,
    );
  }
  if (answer.needsReason && !item.reason) {
    return no(
      'DECISION_REASON_REQUIRED',
      `${answer.label} on ${d.key} takes the person's reason; ask them for it, in their words.`,
    );
  }
  const body = bodyOf(answer, item.reason);
  const round = typeof body.round === 'number' ? body.round : Number.NaN;
  const optionId = typeof body.optionId === 'string' ? body.optionId : null;
  const text = typeof body.text === 'string' ? body.text : null;
  try {
    await answerAs({
      questionId: question,
      answer: optionId ? { kind: 'option', optionId } : { kind: 'text', text: text ?? '' },
      round,
      userId: scope.userId,
      agency: 'human',
      via: 'assistant',
      ...(typeof body.note === 'string' ? { note: body.note } : {}),
    });
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const state = item_ ? await itemStateOf(scope.projectId, item_) : null;
    return no('DECISION_REFUSED', thrownMessage(err), state);
  }
  return {
    outcome: 'done',
    decision: target,
    id: d.id,
    answer: answer.label,
    state: item_ ? await itemStateOf(scope.projectId, item_) : null,
  };
}

/** The toolset that makes agreed decisions for the person a turn answers, on their word. */
export function buildDecideToolset(scope: Scope): ChatToolset {
  return {
    tools: [
      {
        type: 'function',
        function: {
          name: CHAT_DECIDE_TOOL,
          description: DESCRIPTION,
          parameters: z.toJSONSchema(chatDecideParamsSchema, { io: 'input' }) as Record<
            string,
            unknown
          >,
        },
      },
    ],
    ranAs: () => scope.userId,
    async execute(_name, argsJson) {
      let raw: unknown;
      try {
        raw = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        return refused('CHAT_DECIDE_INVALID', 'the arguments were not valid JSON.');
      }
      const params = chatDecideParamsSchema.safeParse(raw);
      if (!params.success) {
        const where = params.error.issues
          .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
          .join('; ');
        return refused('CHAT_DECIDE_INVALID', `${where}.`);
      }
      const { word, decisions: asked } = params.data;
      if (!saidInMessage(word, scope.latestMessage())) {
        return refused(
          'CHAT_DECIDE_NO_WORD',
          `"${word}" is not in the person's latest message, so it is not their word to act. Act only when their current message tells you to, quoting it exactly; otherwise the decision cards under your reply are theirs to press.`,
        );
      }
      const waiting = await readDecisions(scope.projectId, scope.userId);
      const agreedText = `${await scope.answeredReply()}\n${scope.latestMessage()}`;
      const agreed = { keys: keysNamedIn(agreedText), text: agreedText.toUpperCase() };
      const failures = await scope.failures();
      const results: ChatDecisionResult[] = [];
      for (const one of asked) {
        results.push(await decideOne(scope, waiting, agreed, failures, one));
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results,
              note: 'Report each item by its said line, as written: done in the state shown, already_done named done with who moved it and when, refused with its reason and what the person can do next. Add no item they did not agree to, and do not say anything else was done.',
            }),
          },
        ],
      };
    },
  };
}
