// The Product acts a chat puts in a decision set and makes on the person's word (REQ-69 BC-3, BC-4,
// BC-5, BC-10), riding ISS-624's one path: `put_decision_set` keeps each act as core read it, the
// person's later word makes the set whole with `act_on_decisions`, each act goes through its item's
// own door (`item-act-doors.ts`), its result is read back one row per item, and a refused act is kept
// with the refused decisions (`decision-acts.ts`), so one refused twice is not put again and Forge's
// own feedback records it. Text an act saves for the project is held to the project's language first.

import type { ChatDecisionResult, ChatDecisionSetItem } from '@forge/contracts/chat-decide';
import { contentLanguageMisfit, contentLanguageName } from '@forge/contracts/content-language';
import { ITEM_ACTS, type ItemActAsk, itemActId } from '@forge/contracts/item-acts';
import { readContentLanguage } from '../../project-config/index.js';
import { type DecisionRefusal, recordDecisionRefusal, refusedTwiceWhy } from '../decision-acts.js';
import { makeItemAct, nextAfterRefusal } from './item-act-doors.js';
import { type Asker, planItemAct } from './item-act-plans.js';
import { itemActStateOf } from './item-act-state.js';

/** The scope an act is made in: the person, their project, and the room a refusal is counted in. */
export interface ItemActScope extends Asker {
  conversationId: string;
}

/** The first text the act would save that is plainly not in the project's language, as a fault. */
async function languageFault(projectId: string, ask: ItemActAsk): Promise<string | null> {
  const texts: [string, string | undefined][] = [
    ['reason', ask.reason],
    ['triage.note', ask.triage?.note],
    ['triage.answer', ask.triage?.answer],
    ['triage.title', ask.triage?.title],
  ];
  const present = texts.filter((t): t is [string, string] => typeof t[1] === 'string');
  if (present.length === 0) return null;
  const { contentLanguage: tag } = await readContentLanguage(projectId);
  for (const [field, text] of present) {
    const misfit = contentLanguageMisfit(tag, text);
    if (misfit)
      return `ITEM_ACT_NOT_IN_PROJECT_LANGUAGE: ${ask.act} on ${ask.key}: ${field} would be saved for this project, but ${misfit}. Write it in ${contentLanguageName(tag)}, keeping the person's meaning, and put the set again; your reply to them stays in their language.`;
  }
  return null;
}

/** Each act asked, read as the person into a set item, or the faults naming why one cannot be put. */
export async function itemActSetItems(
  scope: ItemActScope,
  asks: readonly ItemActAsk[],
  refusedTwice: ReadonlyMap<string, DecisionRefusal[]>,
): Promise<{ items: (ChatDecisionSetItem & { said: string })[]; faults: string[] }> {
  const items: (ChatDecisionSetItem & { said: string })[] = [];
  const faults: string[] = [];
  for (const ask of asks) {
    const unsaid = await languageFault(scope.projectId, ask);
    if (unsaid) {
      faults.push(unsaid);
      continue;
    }
    const read = await planItemAct(ask, scope);
    if (!read.ok) {
      faults.push(`${read.code}: ${ask.act} on ${ask.key}: ${read.why}`);
      continue;
    }
    const id = itemActId(ask.act, read.key);
    const twice = refusedTwice.get(id);
    if (twice) {
      faults.push(`DECISION_REFUSED_TWICE: ${refusedTwiceWhy(read.key, twice)}`);
      continue;
    }
    if (items.some((i) => i.decision === id)) {
      faults.push(`${ask.act} on ${read.key} is named twice; a set holds each act once.`);
      continue;
    }
    items.push({
      decision: id,
      key: read.key,
      answer: ask.act,
      label: ITEM_ACTS[ask.act].label,
      ...(ask.reason ? { reason: ask.reason } : {}),
      act: read.plan,
      said: read.said,
    });
  }
  return { items, faults };
}

/** Make one act the person agreed, through its door, and read its item back. */
export async function actOnItem(
  scope: ItemActScope,
  item: ChatDecisionSetItem,
): Promise<ChatDecisionResult> {
  const plan = item.act;
  if (!plan) throw new Error(`set item ${item.decision} carries no act, so it is no item act`);
  const made = await makeItemAct(plan, item.reason, scope);
  const state = await itemActStateOf(scope, plan, item.key);
  if (made.ok)
    return { outcome: 'done', decision: item.key, id: item.decision, answer: item.label, state };
  const kept = await recordDecisionRefusal({
    conversationId: scope.conversationId,
    projectId: scope.projectId,
    personId: scope.userId,
    decisionId: item.decision,
    key: item.key,
    via: 'chat',
    code: made.code,
    detail: made.detail,
  });
  const twice = kept.told
    ? ` ${kept.told}`
    : kept.feedbackKey
      ? ` It was refused twice here, so Forge recorded it in its own feedback as ${kept.feedbackKey}.`
      : '';
  return {
    outcome: 'refused',
    decision: item.key,
    code: 'DECISION_REFUSED',
    detail: `${item.label} on ${item.key} was refused by its own door: ${made.detail}${twice}`,
    next: nextAfterRefusal(made.code, item.key),
    state,
  };
}
