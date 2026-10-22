// A decision card pressed under a chat reply, answered in the room with the item read back (REQ-41
// BC-24): the follow-up is written from what core reads now, never from what the browser says.

import type { DecisionOutcomeRequest } from '@forge/contracts/chat-decide';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { postServiceAnswer } from './conversation-adapter.js';
import { type ChatItemStateRead, itemStateOf, stateSentence } from './item-state.js';

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

/** The follow-up a pressed card is answered with: what the press did, as the item now reads. */
export function outcomeSentence(ok: boolean, key: string | null, read: string | null): string {
  if (!key) {
    return ok
      ? 'Your answer was sent. It opens no item, so there is no state to read back.'
      : 'Your answer did not go through; the card says why, and the decision still waits on you.';
  }
  if (!read) {
    return ok
      ? `Your answer on ${key} was sent, and ${key} reads as no item of this project now.`
      : `Your answer on ${key} did not go through, and ${key} reads as no item of this project now.`;
  }
  return ok
    ? `Your answer on ${key} was sent. ${read}`
    : `Your answer on ${key} did not go through; the card says why. ${read}`;
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
  const content = outcomeSentence(pressed.ok, key, state ? stateSentence(state) : null);
  await postServiceAnswer({ conversationId, projectId, askerUserId: userId, content, blocks: [] });
  return { content, state };
}
