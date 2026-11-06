// What a chat keeps about the Needs-you decisions it acts on (REQ-41 BC-25, BC-27, BC-28; ISS-624,
// judge K66 on dev.304): the set it put to the person, which "open them" in a later message acts on
// whole, and each act on a decision that was refused, from a card or from the chat. A decision
// refused twice in a conversation is a defect in Forge, not in the person's words: it is filed into
// Forge's own feedback when the second refusal lands, and it is not offered a third time.

import type { ChatDecisionSetItem } from '@forge/contracts/chat-decide';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type ChatDecisionFailureVia,
  chatDecisionFailures,
  chatDecisionSets,
} from '../db/schema-chat-decisions.js';
import { fileChatDefect } from './agreement/refused-twice.js';

/** Refused acts on one decision a conversation takes before the decision is no longer offered. */
export const DECISION_REFUSALS_ALLOWED = 2;

/** The set a conversation put to its person: what "open them" agrees. */
export interface DecisionSet {
  id: string;
  /** The turn that put it, which an act agreeing it may not be. */
  windowId: string;
  items: ChatDecisionSetItem[];
}

/** Keep a set put to the person; its id is what the act names. */
export async function putDecisionSet(args: {
  conversationId: string;
  projectId: string;
  personId: string;
  windowId: string;
  items: readonly ChatDecisionSetItem[];
}): Promise<string> {
  const [row] = await db
    .insert(chatDecisionSets)
    .values({
      conversationId: args.conversationId,
      projectId: args.projectId,
      personId: args.personId,
      windowId: args.windowId,
      items: [...args.items],
    })
    .returning({ id: chatDecisionSets.id });
  if (!row) throw new Error(`no decision set was kept for conversation ${args.conversationId}`);
  return row.id;
}

/** The newest set the conversation put to its person, or null where it put none. */
export async function newestDecisionSet(conversationId: string): Promise<DecisionSet | null> {
  const [row] = await db
    .select({
      id: chatDecisionSets.id,
      windowId: chatDecisionSets.windowId,
      items: chatDecisionSets.items,
    })
    .from(chatDecisionSets)
    .where(eq(chatDecisionSets.conversationId, conversationId))
    .orderBy(desc(chatDecisionSets.createdAt), desc(chatDecisionSets.id))
    .limit(1);
  return row ?? null;
}

/** One refused act on a decision, as kept. */
export interface DecisionRefusal {
  key: string;
  via: ChatDecisionFailureVia;
  code: string;
  detail: string;
  /** The Forge feedback item the defect was filed as, on the refusal that made it twice. */
  feedbackKey: string | null;
}

/** Each decision refused at least twice in the conversation, by its id, with its refusals oldest first. */
export async function decisionsRefusedTwice(
  conversationId: string,
): Promise<Map<string, DecisionRefusal[]>> {
  const rows = await db
    .select()
    .from(chatDecisionFailures)
    .where(eq(chatDecisionFailures.conversationId, conversationId))
    .orderBy(asc(chatDecisionFailures.createdAt), asc(chatDecisionFailures.id));
  const by = new Map<string, DecisionRefusal[]>();
  for (const r of rows) {
    by.set(r.decisionId, [
      ...(by.get(r.decisionId) ?? []),
      { key: r.itemKey, via: r.via, code: r.code, detail: r.detail, feedbackKey: r.feedbackKey },
    ]);
  }
  for (const [id, refusals] of by) if (refusals.length < DECISION_REFUSALS_ALLOWED) by.delete(id);
  return by;
}

const VIA_WORDS: Record<ChatDecisionFailureVia, string> = {
  card: 'its card was pressed',
  chat: 'the chat acted on the person’s word',
};

/** Why a decision is not offered again: each refusal, and the feedback item recording them. */
export function refusedTwiceWhy(key: string, refusals: readonly DecisionRefusal[]): string {
  const each = refusals
    .map((r) => `${r.code} when ${VIA_WORDS[r.via]} (${r.detail.slice(0, 160)})`)
    .join('; ');
  const filed = refusals.find((r) => r.feedbackKey)?.feedbackKey;
  const recorded = filed
    ? ` Forge recorded the defect in its own feedback as ${filed}; name ${filed} to the person.`
    : ' Forge could not record the defect in its own feedback; say that too.';
  return `The act on ${key} was refused ${refusals.length} times in this conversation: ${each}. A third would be refused the same way, so it is not offered again.${recorded}`;
}

/**
 * Keep one refused act on a decision. The refusal that makes it twice files the defect into Forge's
 * own feedback first, so its row names the item; the sentence the model is told is returned then.
 */
export async function recordDecisionRefusal(args: {
  conversationId: string;
  projectId: string;
  personId: string;
  decisionId: string;
  key: string;
  via: ChatDecisionFailureVia;
  code: string;
  detail: string;
}): Promise<{ count: number; feedbackKey: string | null; told: string | null }> {
  const earlier = await db
    .select()
    .from(chatDecisionFailures)
    .where(
      and(
        eq(chatDecisionFailures.conversationId, args.conversationId),
        eq(chatDecisionFailures.decisionId, args.decisionId),
      ),
    )
    .orderBy(asc(chatDecisionFailures.createdAt));
  const count = earlier.length + 1;
  const filed =
    count === DECISION_REFUSALS_ALLOWED
      ? await fileChatDefect({
          projectId: args.projectId,
          conversationId: args.conversationId,
          personId: args.personId,
          title: `The chat's decision on ${args.key} was refused each time it was acted on`,
          body: [
            `In conversation ${args.conversationId}, the decision on ${args.key} (${args.decisionId}) was refused ${count} times:`,
            ...[...earlier, args].map(
              (r) => `- ${VIA_WORDS[r.via]}: ${r.code}: ${r.detail.slice(0, 300)}`,
            ),
            'It is no longer offered in this conversation (REQ-41 BC-28): the act the chat offers for this decision fails when made.',
          ],
          signalKey: `chat:refused-twice:decision:${earlier[0]?.code ?? args.code}`,
        })
      : null;
  await db.insert(chatDecisionFailures).values({
    conversationId: args.conversationId,
    projectId: args.projectId,
    personId: args.personId,
    decisionId: args.decisionId,
    itemKey: args.key,
    via: args.via,
    code: args.code,
    detail: args.detail,
    feedbackKey: filed?.key ?? null,
  });
  return { count, feedbackKey: filed?.key ?? null, told: filed?.told ?? null };
}
