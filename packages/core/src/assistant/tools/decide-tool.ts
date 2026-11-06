// `act_on_decisions`: the chat assistant makes the Needs-you decisions the conversation agreed, as the
// person and with their own access, when their current message tells it to (REQ-41 BC-25). Dev,
// 2026-10-22: the owner agreed a cluster of drafts, said (in Vietnamese) "OK, open that cluster for me"
// and then "I said open them for me", and twice heard "I cannot press approval for you". Core checks the word, not
// the model: the call quotes the person's instruction, and is refused by name unless that quote is
// in their latest message. Only a decision answered by a question's own answer route is made here;
// any other act is refused by name and its card stays. Every item is read back after the act, and
// an item that needed no act is named done with who moved it and when (BC-24, BC-27).
//
// What the person agreed is core's, not the prompt's (judge K66 on dev.304, ISS-624): the chat puts a
// set to them with `put_decision_set`, and the act on their word runs on the newest set put in an
// earlier turn, whole, so the model can neither widen nor narrow it. A decision named outside a set is
// made only where the person's current message names it by its key. An act refused is kept
// (`decision-acts.ts`); a decision refused twice in the conversation is not offered or made again,
// and Forge's own feedback records it (BC-28).

import {
  CHAT_DECIDE_TOOL,
  CHAT_DECISION_SET_TOOL,
  type ChatDecideRefusalCode,
  type ChatDecisionRefusalCode,
  type ChatDecisionResult,
  type ChatDecisionSetItem,
  chatDecideParamsSchema,
  chatDecisionSetParamsSchema,
} from '@forge/contracts/chat-decide';
import type { DecisionAnswer, NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { z } from 'zod';
import { isRefusal, RefusalError } from '../../lib/refusal.js';
import { answerAs } from '../../questions/index.js';
import {
  type DecisionRefusal,
  decisionsRefusedTwice,
  newestDecisionSet,
  putDecisionSet,
  recordDecisionRefusal,
  refusedTwiceWhy,
} from '../decision-acts.js';
import { type ItemKind, itemKindOf, itemStateOf } from '../item-state.js';
import { type ChatToolset, thrownMessage, toolError } from './mcp-adapter.js';

const DESCRIPTION = [
  'Make the Needs-you decisions the person agreed, as the person and with their own access, when their CURRENT message tells you to (e.g. "open them for me", "mở giúp tôi đi").', // i18n-allow: the Vietnamese instruction the model must recognise
  'word: their instruction, quoted exactly from their latest message; the call is refused unless it is there.',
  `set: the id ${CHAT_DECISION_SET_TOOL} returned when you put the set to them in an earlier turn; it is acted on whole, exactly as put.`,
  'decisions: only where no set was put and their current message names each decision by its key (REQ-12, FB-7, ISS-5), with answer (an answer id; left out, the recommended one) and reason where the answer takes one. A decision their message does not name is refused DECISION_NOT_AGREED.',
  'Each result is read back: done with the item state, already_done with who moved it and when, or refused with why. Report every one as it says.',
  'Without their word in this message, do not call it: the decision cards under your reply are theirs to press.',
].join(' ');

const SET_DESCRIPTION = [
  'Put a set of Needs-you decisions to the person for their agreement, before they say to make them ("open them").',
  'decisions: each by its forge_needs_you id or the key of the item it opens, with answer (an answer id; left out, the recommended one) and reason where the answer takes one.',
  `Core keeps the set and returns its id; list exactly its items to the person and ask them to agree. Once a later message of theirs agrees, call ${CHAT_DECIDE_TOOL} with that set: it acts on all of it and nothing else. To change the set, put a new one.`,
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
  if (opens && (opens.kind === 'requirement' || opens.kind === 'feedback')) {
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
  /** The room the turn answers in: where a set is kept and a refused act counted. */
  conversationId: string;
  /** The turn: a set it put is not one the person has seen. */
  windowId: string;
  /** The person's latest message in this conversation: the word an act stands on. */
  latestMessage: () => string;
}

/** Whether the person's message names `key` (ISS-5, REQ-12) as a word of its own. */
export function namedInMessage(key: string, latest: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) return false;
  return new RegExp(`(?<![\\w-])${key}(?![\\w-])`, 'iu').test(latest.normalize('NFC'));
}

/** One decision as asked: by the set (its key read back where it no longer waits), or by the person's message. */
interface Asked {
  decision: string;
  answer?: string | undefined;
  reason?: string | undefined;
  /** The row's key a set kept, read back where the decision no longer waits. */
  key?: string | undefined;
}

/** How the asked decisions were agreed: by a set put to the person, or by their message naming each. */
type AgreedBy = 'set' | 'message';

/** A decision resolved to the act its card makes, or why it cannot be made from chat. */
type Resolved =
  | { ok: true; d: NeedsYouDecision; answer: DecisionAnswer; question: string }
  | { ok: false; code: ChatDecisionRefusalCode; detail: string };

/** The act `item` asks of `d`, as its card would make it, or the refusal naming why not. */
function resolve(
  d: NeedsYouDecision,
  item: Asked,
  refusedTwice: ReadonlyMap<string, DecisionRefusal[]>,
): Resolved {
  const twice = refusedTwice.get(d.id);
  if (twice)
    return { ok: false, code: 'DECISION_REFUSED_TWICE', detail: refusedTwiceWhy(d.key, twice) };
  const answerId = item.answer ?? d.recommended?.answerId;
  if (!answerId) {
    return {
      ok: false,
      code: 'DECISION_NO_RECOMMENDATION',
      detail: `${d.id} recommends no answer (${d.noRecommendation ?? 'none given'}); ask the person which of ${d.answers.map((a) => a.id).join(', ')} they mean.`,
    };
  }
  const answer = d.answers.find((a) => a.id === answerId);
  if (!answer) {
    return {
      ok: false,
      code: 'DECISION_ANSWER_UNKNOWN',
      detail: `${d.id} has no answer ${answerId}; its answers are ${d.answers.map((a) => a.id).join(', ')}.`,
    };
  }
  const question = QUESTION_PATH.exec(answer.path)?.[1];
  if (answer.act !== 'question.answer' || !question) {
    return {
      ok: false,
      code: 'DECISION_ACT_ON_ITS_PAGE',
      detail: `${d.id} is a ${answer.act} decision, made on its card or its page by the person; only a question's answer is made from chat. Its card stays.`,
    };
  }
  if (answer.needsReason && !item.reason) {
    return {
      ok: false,
      code: 'DECISION_REASON_REQUIRED',
      detail: `${answer.label} on ${d.key} takes the person's reason; ask them for it, in their words.`,
    };
  }
  return { ok: true, d, answer, question };
}

async function decideOne(
  scope: Scope,
  decisions: readonly NeedsYouDecision[],
  item: Asked,
  agreedBy: AgreedBy,
  refusedTwice: ReadonlyMap<string, DecisionRefusal[]>,
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
  if (agreedBy === 'message') {
    const keys = d ? [d.key, d.opens?.key ?? ''] : [target];
    if (!keys.some((k) => namedInMessage(k, scope.latestMessage()))) {
      return no(
        'DECISION_NOT_AGREED',
        `${d?.key ?? target} is in no set put to the person and their current message does not name it, so nothing of theirs agreed it. Put the set to them with ${CHAT_DECISION_SET_TOOL} and act once they agree it.`,
      );
    }
  }
  const item_ = itemOf(d, item.key ?? target);
  if (!d) {
    const state = item_ ? await itemStateOf(scope.projectId, item_) : null;
    if (state) return { outcome: 'already_done', decision: target, state };
    return no(
      'DECISION_UNKNOWN',
      `${target} names no decision waiting on the person and no item of this project.`,
    );
  }
  const resolved = resolve(d, item, refusedTwice);
  if (!resolved.ok) return no(resolved.code, resolved.detail);
  const { answer, question } = resolved;
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
    const said = thrownMessage(err);
    const kept = await recordDecisionRefusal({
      conversationId: scope.conversationId,
      projectId: scope.projectId,
      personId: scope.userId,
      decisionId: d.id,
      key: d.key,
      via: 'chat',
      code: err instanceof RefusalError ? (err.refusals[0]?.code ?? err.fallbackCode) : 'REFUSED',
      detail: said,
    });
    return no('DECISION_REFUSED', kept.told ? `${said} ${kept.told}` : said, state);
  }
  return {
    outcome: 'done',
    decision: target,
    id: d.id,
    answer: answer.label,
    state: item_ ? await itemStateOf(scope.projectId, item_) : null,
  };
}

/** The params as the schema reads them, or the refusal naming each field it could not. */
function parsed<T>(
  schema: z.ZodType<T>,
  argsJson: string,
): { ok: true; value: T } | { ok: false; refusal: ReturnType<typeof refused> } {
  let raw: unknown;
  try {
    raw = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return {
      ok: false,
      refusal: refused('CHAT_DECIDE_INVALID', 'the arguments were not valid JSON.'),
    };
  }
  const params = schema.safeParse(raw);
  if (params.success) return { ok: true, value: params.data };
  const where = params.error.issues
    .map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`)
    .join('; ');
  return { ok: false, refusal: refused('CHAT_DECIDE_INVALID', `${where}.`) };
}

const asJson = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

/** `put_decision_set`: keep the set, each decision resolved to its act, or refuse it whole by name. */
async function putSet(scope: Scope, argsJson: string) {
  const params = parsed(chatDecisionSetParamsSchema, argsJson);
  if (!params.ok) return params.refusal;
  const waiting = await readDecisions(scope.projectId, scope.userId);
  const twice = await decisionsRefusedTwice(scope.conversationId);
  const items: ChatDecisionSetItem[] = [];
  const faults: string[] = [];
  for (const asked of params.value.decisions) {
    const found = matching(waiting, asked.decision);
    if (found.length !== 1) {
      faults.push(
        found.length
          ? `DECISION_AMBIGUOUS: ${asked.decision} names ${found.length} decisions (${found.map((d) => d.id).join(', ')}); name one by its id.`
          : `DECISION_UNKNOWN: ${asked.decision} names no decision waiting on the person.`,
      );
      continue;
    }
    const resolved = resolve(found[0] as NeedsYouDecision, asked, twice);
    if (!resolved.ok) {
      faults.push(`${resolved.code}: ${resolved.detail}`);
      continue;
    }
    if (items.some((i) => i.decision === resolved.d.id)) {
      faults.push(`${resolved.d.key} is named twice; a set holds each decision once.`);
      continue;
    }
    items.push({
      decision: resolved.d.id,
      key: resolved.d.key,
      answer: resolved.answer.id,
      label: resolved.answer.label,
      ...(asked.reason ? { reason: asked.reason } : {}),
    });
  }
  if (faults.length) {
    return toolError(
      `CHAT_DECISION_SET_REFUSED: ${faults.join(' ')} No set was kept; put one holding only decisions the chat can make.`,
    );
  }
  const set = await putDecisionSet({
    conversationId: scope.conversationId,
    projectId: scope.projectId,
    personId: scope.userId,
    windowId: scope.windowId,
    items,
  });
  return asJson({
    set,
    items: items.map((i) => ({ decision: i.decision, key: i.key, answer: i.label })),
    note: `List exactly these to the person, each by its key and answer, and ask them to agree. When a later message of theirs agrees, call ${CHAT_DECIDE_TOOL} with set ${set}: it makes all of them and nothing else. Do not make them in this turn.`,
  });
}

/** `act_on_decisions`: on the person's word, make the set they agreed, or the decisions their message names. */
async function actOnWord(scope: Scope, argsJson: string) {
  const params = parsed(chatDecideParamsSchema, argsJson);
  if (!params.ok) return params.refusal;
  const { word, set, decisions: named } = params.value;
  if (!saidInMessage(word, scope.latestMessage())) {
    return refused(
      'CHAT_DECIDE_NO_WORD',
      `"${word}" is not in the person's latest message, so it is not their word to act. Act only when their current message tells you to, quoting it exactly; otherwise the decision cards under your reply are theirs to press.`,
    );
  }
  let asked: Asked[];
  if (set !== undefined) {
    const newest = await newestDecisionSet(scope.conversationId);
    if (!newest || newest.id !== set) {
      return refused(
        'CHAT_DECIDE_SET_UNKNOWN',
        newest
          ? `${set} is not the set last put to the person; that is ${newest.id} (${newest.items.map((i) => i.key).join(', ')}), the one "open them" agrees.`
          : `${set} names no set: none was put to the person in this conversation. Put one with ${CHAT_DECISION_SET_TOOL} first.`,
      );
    }
    if (newest.windowId === scope.windowId) {
      return refused(
        'CHAT_DECIDE_SET_UNSEEN',
        `set ${set} was put in this same turn, so the person has not seen it and their word cannot agree it. List it to them, and act once a later message of theirs agrees.`,
      );
    }
    asked = newest.items.map((i) => ({
      decision: i.decision,
      answer: i.answer,
      reason: i.reason,
      key: i.key,
    }));
  } else {
    asked = named ?? [];
  }
  const waiting = await readDecisions(scope.projectId, scope.userId);
  const twice = await decisionsRefusedTwice(scope.conversationId);
  const agreedBy: AgreedBy = set !== undefined ? 'set' : 'message';
  const results: ChatDecisionResult[] = [];
  for (const one of asked) results.push(await decideOne(scope, waiting, one, agreedBy, twice));
  return asJson({
    results,
    note: 'Report each item exactly as read back here: done in the state shown, already_done named done with who moved it and when, refused with its reason and what the person can do next. Add no item they did not agree to, and do not say anything else was done.',
  });
}

/** The toolset that puts a set to the person and makes the decisions they agreed, on their word. */
export function buildDecideToolset(scope: Scope): ChatToolset {
  const tool = (name: string, description: string, schema: z.ZodType) => ({
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    },
  });
  return {
    tools: [
      tool(CHAT_DECISION_SET_TOOL, SET_DESCRIPTION, chatDecisionSetParamsSchema),
      tool(CHAT_DECIDE_TOOL, DESCRIPTION, chatDecideParamsSchema),
    ],
    ranAs: () => scope.userId,
    async execute(name, argsJson) {
      if (name === CHAT_DECISION_SET_TOOL) return putSet(scope, argsJson);
      return actOnWord(scope, argsJson);
    },
  };
}
