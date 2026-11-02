/**
 * Answering a widget visitor: the window their message opened is claimed, one widget turn is taken
 * over it (`assistant/widget-turn.ts`), the reply goes out on the session's stream and into the
 * transcript, and the window closes carrying the decision, as every adapter's does.
 *
 * It is not the project turn's `routeWindow`: that one acts as the Forge person whose message it
 * answers, and a visitor is nobody Forge knows. What is shared is everything around the turn: the
 * collector window and its claim, the delivery key and its reservation, the transcript row, the
 * screen. A window a stopped core left behind is answered by the drain timer.
 */

import { type WidgetPageContext, widgetPageContextSchema } from '@forge/contracts/widget';
import { runWidgetTurn, type WidgetTurnLine } from '../assistant/index.js';
import {
  type ClaimedWindow,
  claimDueWindows,
  claimLastResort,
  claimOf,
  closeWindow,
  codeAuthored,
  languageOfTag,
  readMessages,
  recordDeliveredReply,
  releaseLastResort,
  replyLanguageOf,
  reserveDelivery,
  type ScreenedMessage,
  type StoredConversationMessage,
  windowDeliveryKey,
} from '../conversations/index.js';
import type { ConversationWindowDecision } from '../db/schema-conversations.js';
import { activeWidgetBinding } from '../integrations/widget/index.js';
import { logger } from '../lib/logger.js';
import { proposeDraft } from './drafts.js';
import { publishWidgetEvent } from './events.js';
import { widgetConversationPorts, widgetVenueId, widgetVenueOf } from './ports.js';
import { pendingDraftOf, type SessionRow, sessionOfConversation } from './store.js';

/** How many windows one venue's send routes, the visitor's own and any that queued behind it. */
const VENUE_ROUNDS = 3;
/** How many lines a turn reads back. */
const HISTORY_LINES = 40;
/** The title a site with none is spoken for as. */
export const DEFAULT_WIDGET_TITLE = 'Support';

const pageOf = (raw: unknown): WidgetPageContext | null => {
  const parsed = widgetPageContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

function linesOf(rows: readonly StoredConversationMessage[]): WidgetTurnLine[] {
  return rows.flatMap((row): WidgetTurnLine[] => {
    if (row.silenceReason !== null || row.content.trim() === '') return [];
    if (row.role === 'user') return [{ role: 'visitor', text: row.content }];
    if (row.role === 'assistant') return [{ role: 'assistant', text: row.content }];
    return [];
  });
}

/** Claim and answer whatever this session's venue owes, its own window first. */
export async function answerSession(sessionId: string, claimant: string): Promise<void> {
  for (let round = 0; round < VENUE_ROUNDS; round++) {
    const [window] = await claimDueWindows({
      adapter: 'widget',
      claimant,
      limit: 1,
      venuePrefixes: [widgetVenueId(sessionId)],
      settleMs: 0,
    });
    if (!window) return;
    await routeWidgetWindow(window);
  }
}

export async function routeWidgetWindow(
  window: ClaimedWindow,
): Promise<ConversationWindowDecision> {
  const claim = claimOf(window);
  if (!claim)
    throw new Error('widget: a window is routed under its claim, and this one holds none');
  const close = async (decision: ConversationWindowDecision, detail: Record<string, unknown>) => {
    await closeWindow({ windowId: window.id, decision, detail, claim });
    return decision;
  };
  const session = await sessionOfConversation(window.conversationId);
  if (!session)
    return close('unreachable', { reason: 'no widget session opened this conversation' });
  const binding = await activeWidgetBinding({ bindingId: session.bindingId });
  if (!binding) {
    return close('unreachable', { reason: "the session's widget binding is switched off" });
  }
  const title = binding.config.title ?? DEFAULT_WIDGET_TITLE;
  publishWidgetEvent(window.conversationId, { type: 'typing', on: true });
  try {
    const lines = linesOf(await readMessages(window.conversationId, HISTORY_LINES));
    const page = pageOf(session.pageContext);
    const language =
      replyLanguageOf([...lines].reverse().find((l) => l.role === 'visitor')?.text) ??
      languageOfTag(page?.locale);
    let message: ScreenedMessage | null;
    let failure: string | null = null;
    try {
      const pending = await pendingDraftOf(session.id);
      const turn = await runWidgetTurn({
        projectId: session.projectId,
        conversationId: window.conversationId,
        site: { title, greeting: binding.config.greeting ?? null },
        lines,
        pageContext: page,
        pending: pending
          ? {
              kind: pending.kind,
              title: pending.title,
              saw: pending.saw,
              ...(pending.did ? { did: pending.did } : {}),
              ...(pending.expected ? { expected: pending.expected } : {}),
              ...(pending.whereSeen ? { whereSeen: pending.whereSeen } : {}),
            }
          : null,
        propose: (draft) => proposeDraft(session, draft),
        language,
      });
      message = turn.message;
      if (turn.failed) failure = turn.error ?? 'the turn broke off before it wrote anything';
      else if (turn.terminal === 'error') failure = turn.error;
    } catch (err) {
      logger.error({ err, windowId: window.id }, 'widget: the turn did not run');
      failure = err instanceof Error ? err.message : String(err);
      message = null;
    }
    if (!message && failure) {
      // the visitor typed and is waiting, and the agent could not speak: core's one line for it
      return close('unreachable', { ...(await tellTurnFailed(session, window, claim)), failure });
    }
    if (!message || message.text.trim() === '') {
      return close('nothing-to-say', { reason: 'the turn wrote nothing', failure });
    }
    return close('answered', {
      ...(await deliver(session, window, claim, message)),
      ...(failure ? { failure } : {}),
    });
  } finally {
    publishWidgetEvent(window.conversationId, { type: 'typing', on: false });
  }
}

async function deliver(
  session: SessionRow,
  window: ClaimedWindow,
  claim: NonNullable<ReturnType<typeof claimOf>>,
  message: ScreenedMessage,
): Promise<Record<string, unknown>> {
  const deliveryKey = windowDeliveryKey(window.id);
  if (!(await reserveDelivery(window.id, claim))) {
    return { deliveryKey, superseded: 'the claim moved on before the reply went out' };
  }
  const receipt = await widgetConversationPorts.deliver(widgetVenueOf(session), message);
  await recordDeliveredReply({
    conversationId: window.conversationId,
    projectId: session.projectId,
    text: message.text,
    ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
    receipt,
    deliveryKey,
  });
  return { deliveryKey, messageId: receipt.messageId };
}

/**
 * Tell the visitor their turn failed, in core's one last-resort line for the conversation, where it
 * was told none yet (ISS-875); a delivery that does not go out gives the claim back.
 */
async function tellTurnFailed(
  session: SessionRow,
  window: ClaimedWindow,
  claim: NonNullable<ReturnType<typeof claimOf>>,
): Promise<Record<string, unknown>> {
  const place = { adapter: 'widget', venue: widgetVenueOf(session).externalId };
  const line = await claimLastResort(place, 'turn_failed');
  if (!line)
    return { told: false, reason: 'the conversation was told its one last-resort line already' };
  try {
    const out = await deliver(session, window, claim, codeAuthored(line));
    // the claim moved on before the line went out: the thread was told nothing
    if ('superseded' in out) await releaseLastResort(place);
    return { told: !('superseded' in out), ...out };
  } catch (err) {
    await releaseLastResort(place);
    throw err;
  }
}

/** How many stranded windows one drain tick takes. */
const WIDGET_DRAIN_BATCH = 5;

/** Answer every widget window a stopped core left behind. */
export async function drainWidgetConversationWindows(): Promise<void> {
  const windows = await claimDueWindows({
    adapter: 'widget',
    claimant: 'widget-drain',
    limit: WIDGET_DRAIN_BATCH,
  });
  for (const window of windows) {
    await routeWidgetWindow(window).catch((err: unknown) =>
      logger.error({ err, windowId: window.id }, 'widget: routing a stranded window failed'),
    );
  }
}
