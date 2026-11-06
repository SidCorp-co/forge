// A decision card pressed under a chat reply, answered in the room with the item read back (REQ-41
// BC-24): the follow-up is written from what core reads now. A press that failed says why: the
// refusal core gave the browser that pressed, named with its code (judge K66 on dev.304: "the card
// says why" named no reason), and what the person can do next. A failed press is kept as a refused
// act on its decision, so one refused twice is not offered again and Forge's feedback records it
// (BC-28, `decision-acts.ts`).

import type { DecisionOutcomeRequest, DecisionPressFailure } from '@forge/contracts/chat-decide';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { conversationWindows } from '../db/schema-conversations.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { postServiceAnswer } from './conversation-adapter.js';
import { recordDecisionRefusal } from './decision-acts.js';
import { type ChatItemStateRead, itemKindOf, itemStateOf, stateSentence } from './item-state.js';

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

/** What a failed press says: why core refused it, and what the person can do next. */
export interface PressFailed extends DecisionPressFailure {
  /** The Forge feedback item the press's second refusal was filed as, where this one made it twice. */
  feedbackKey: string | null;
}

/** The sentences after a failed press: the refusal, and the way on. */
function failedWords(failure: PressFailed): string {
  const why = `Forge refused it: ${failure.code}: ${failure.detail.replace(/\s+$/u, '')}`;
  const stop = /[.!?]$/.test(why) ? '' : '.';
  const next = failure.feedbackKey
    ? ` It was refused twice here, so Forge recorded it in its own feedback as ${failure.feedbackKey} and the chat will not offer it again; decide it on its own page.`
    : ' The decision still waits on you: press the card again once that is fixed, or decide it on its own page.';
  return `${why}${stop}${next}`;
}

/** The follow-up a pressed card is answered with: what the press did, as the item now reads. */
export function outcomeSentence(
  failure: PressFailed | null,
  key: string | null,
  read: string | null,
): string {
  if (!key) {
    return failure
      ? `Your answer did not go through. ${failedWords(failure)}`
      : 'Your answer was sent. It opens no item, so there is no state to read back.';
  }
  if (!read) {
    return failure
      ? `Your answer on ${key} did not go through, and ${key} reads as no item of this project now. ${failedWords(failure)}`
      : `Your answer on ${key} was sent, and ${key} reads as no item of this project now.`;
  }
  return failure
    ? `Your answer on ${key} did not go through. ${failedWords(failure)} ${read}`
    : `Your answer on ${key} was sent. ${read}`;
}

/** The item a pressed card reads back: the one it opens, else its row's own key where that is an item. */
function pressedItem(pressed: DecisionOutcomeRequest) {
  if (pressed.opens) return { kind: pressed.opens.kind, key: pressed.opens.key };
  const kind = itemKindOf(pressed.key);
  return kind ? { kind, key: pressed.key } : null;
}

/** Reads the item back in the room's project and posts the follow-up as the room's handle. */
export async function answerPressedCard(
  conversationId: string,
  userId: string,
  pressed: DecisionOutcomeRequest,
): Promise<{ content: string; state: ChatItemStateRead }> {
  const projectId = await answeringProject(conversationId);
  await loadProjectAccess(projectId, userId);
  const item = pressedItem(pressed);
  const key = item?.key.toUpperCase() ?? null;
  const state = item ? await itemStateOf(projectId, item) : null;
  const failure = pressed.ok
    ? null
    : {
        ...pressed.failure,
        feedbackKey: (
          await recordDecisionRefusal({
            conversationId,
            projectId,
            personId: userId,
            decisionId: pressed.decision,
            key: pressed.key,
            via: 'card',
            code: pressed.failure.code,
            detail: pressed.failure.detail,
          })
        ).feedbackKey,
      };
  const content = outcomeSentence(failure, key, state ? stateSentence(state) : null);
  await postServiceAnswer({ conversationId, projectId, askerUserId: userId, content, blocks: [] });
  return { content, state };
}
