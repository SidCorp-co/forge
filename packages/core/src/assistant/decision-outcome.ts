// A decision card pressed under a chat reply, answered in the room with the item read back (REQ-41
// BC-24): the follow-up is written from what core reads now. A press that failed says why, in the
// refusal its route answered with, and what to do next, read from whether the decision still waits
// on the person (judge K66 on ISS-624 c2); it is kept on the follow-up as a `decision_card` block, so
// a third try on the same item is refused from chat as from its card (BC-28).

import { randomUUID } from 'node:crypto';
import {
  CHAT_DECISION_CARD_BLOCK,
  type DecisionOutcomeRequest,
  type DecisionRefusal,
} from '@forge/contracts/chat-decide';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { postServiceAnswer } from './conversation-adapter.js';
import { type ChatItemStateRead, itemStateOf, stateSentence } from './item-state.js';
import { readDecisions } from './tools/decide-tool.js';

const refuse = refuser<'DECISION_OUTCOME_NO_PROJECT'>('DECISION_OUTCOME_NO_PROJECT');

/** The project the room's newest turn answered about: the one its decision cards were read from. */
async function answeringProject(conversationId: string): Promise<string> {
  const [w] = await db
    .select({ projectId: conversationWindows.projectId })
    .from(conversationWindows)
    .where(eq(conversationWindows.conversationId, conversationId))
    .orderBy(desc(conversationWindows.openedAt))
    .limit(1);
  if (!w) {
    throw refuse(
      'DECISION_OUTCOME_NO_PROJECT',
      `conversation ${conversationId} has had no turn, so no decision card was drawn in it to report on`,
    );
  }
  return w.projectId;
}

/** What a person can do after a press that failed: press again once its cause is gone, or decide it on its page. */
export function nextStep(stillWaits: boolean, key: string | null): string {
  if (!stillWaits) return 'It no longer waits on you, so there is nothing to press again.';
  return key
    ? `It still waits on you: press it again once that is fixed, or open ${key} and decide it there.`
    : 'It still waits on you: press it again once that is fixed, or decide it in Needs you.';
}

/** The follow-up a pressed card is answered with: what the press did, as the item now reads, and why one failed. */
export function outcomeSentence(
  pressed: { ok: boolean; refusal: DecisionRefusal | null },
  key: string | null,
  read: string | null,
  next: string,
): string {
  const why = pressed.refusal
    ? `: ${pressed.refusal.detail.replace(/[.\s]+$/, '')} (${pressed.refusal.code}).`
    : '.';
  if (!key) {
    return pressed.ok
      ? 'Your answer was sent. It opens no item, so there is no state to read back.'
      : `Your answer did not go through${why} ${next}`;
  }
  if (!read) {
    return pressed.ok
      ? `Your answer on ${key} was sent, and ${key} reads as no item of this project now.`
      : `Your answer on ${key} did not go through${why} ${key} reads as no item of this project now. ${next}`;
  }
  return pressed.ok
    ? `Your answer on ${key} was sent. ${read}`
    : `Your answer on ${key} did not go through${why} ${read} ${next}`;
}

/** Reads the item back in the room's project and posts the follow-up as the room's handle. */
export async function answerPressedCard(
  conversationId: string,
  userId: string,
  pressed: DecisionOutcomeRequest,
): Promise<{ content: string; state: ChatItemStateRead }> {
  const projectId = await answeringProject(conversationId);
  await loadProjectAccess(projectId, userId);
  const key = pressed.opens?.key.toUpperCase() ?? null;
  const state = pressed.opens
    ? await itemStateOf(projectId, { kind: pressed.opens.kind, key: pressed.opens.key })
    : null;
  const next = pressed.ok
    ? ''
    : nextStep(
        (await readDecisions(projectId, userId)).some((d) => d.id === pressed.decision),
        key,
      );
  const content = outcomeSentence(pressed, key, state ? stateSentence(state) : null, next);
  // a failed press is kept where the conversation holds its other tries (`decision-memory.ts`)
  const blocks = pressed.refusal
    ? [
        {
          type: 'tool' as const,
          toolCall: {
            id: randomUUID(),
            name: CHAT_DECISION_CARD_BLOCK,
            input: { decision: pressed.decision, key, code: pressed.refusal.code },
            output: pressed.refusal.detail,
            isError: true,
          },
        },
      ]
    : [];
  await postServiceAnswer({ conversationId, projectId, askerUserId: userId, content, blocks });
  return { content, state };
}
