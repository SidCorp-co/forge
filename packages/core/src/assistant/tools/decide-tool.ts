// `act_on_decisions`: the chat assistant makes the Needs-you decisions the conversation agreed, as the
// person and with their own access, when their current message tells it to (REQ-41 BC-25). Dev,
// 2026-10-22: the owner agreed a cluster of drafts, said (in Vietnamese) "OK, open that cluster for me"
// and then "I said open them for me", and twice heard "I cannot press approval for you". Core checks the word, not
// the model: the call quotes the person's instruction, and is refused by name unless that quote is
// in their latest message. Only a decision answered by a question's own answer route is made here;
// any other act is refused by name and its card stays. Every item is read back after the act, and
// an item that needed no act is named done with who moved it and when (BC-24, BC-27).

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
import { type ItemKind, itemKindOf, itemStateOf } from '../item-state.js';
import { type ChatToolset, thrownMessage, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Make the Needs-you decisions this conversation agreed, as the person and with their own access, when their CURRENT message tells you to (e.g. "open them for me", "mở giúp tôi đi").', // i18n-allow: the Vietnamese instruction the model must recognise
  'word: their instruction, quoted exactly from their latest message; the call is refused unless it is there.',
  'decisions: exactly the decisions agreed, each by its forge_needs_you id or the key it opens (ISS-603), with answer (an answer id; left out, the recommended one) and reason where the answer takes one. Never add one they did not agree to.',
  'Each result is read back: done with the item state, already_done with who moved it and when, or refused with why. Report every one as it says.',
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

function readDecisions(projectId: string, userId: string): Promise<readonly NeedsYouDecision[]> {
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
}

async function decideOne(
  scope: Scope,
  decisions: readonly NeedsYouDecision[],
  item: { decision: string; answer?: string | undefined; reason?: string | undefined },
): Promise<ChatDecisionResult> {
  const target = item.decision;
  const no = (
    code: ChatDecisionRefusalCode,
    detail: string,
    state = null as ChatDecisionResult['state'],
  ) => ({ outcome: 'refused', decision: target, code, detail, state }) as ChatDecisionResult;
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
      const results: ChatDecisionResult[] = [];
      for (const one of asked) results.push(await decideOne(scope, waiting, one));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results,
              note: 'Report each item exactly as read back here: done in the state shown, already_done named done with who moved it and when, refused with its reason and what the person can do next. Add no item they did not agree to, and do not say anything else was done.',
            }),
          },
        ],
      };
    },
  };
}
