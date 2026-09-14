/**
 * Taking the decision a window is for, and writing down what it was.
 *
 * A claimed window arrives here with its messages already in the log. This asks
 * the three proactivity guards, and either runs one turn over everything the
 * window accumulated or closes the window naming the guard that stopped it.
 * Either way the window closes carrying a decision, which is the record a person
 * reads when they ask why nothing was said (ISS-1004 rule 4).
 *
 * The turn itself is the neutral runner's and the inputs are the adapter's; this
 * is the piece between them that decides whether to take one at all.
 */

import type { ConversationWindowDecision } from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import type { ConversationVenue } from './ports.js';
import { decideProactivity } from './proactivity.js';
import {
  deliveredUnderKey,
  getConversation,
  readMessages,
  type StoredConversationMessage,
} from './store.js';
import { type ConversationTurnRequest, runConversationTurn } from './turn-runner.js';
import {
  type ConversationWindowRow,
  closeWindow,
  reserveDelivery,
  windowDeliveryKey,
} from './windows.js';

/** Everything the neutral runner takes bar what the window itself settles. */
export type WindowTurnInputs = Omit<
  ConversationTurnRequest,
  | 'venue'
  | 'principalUserId'
  | 'speakerKey'
  | 'message'
  | 'questionAlreadyRecorded'
  | 'mayDecline'
  | 'deliveryKey'
  | 'onBeforeDeliver'
>;

export interface RouteWindowArgs {
  window: ConversationWindowRow;
  /** Whose authority a turn runs under in a venue that has many speakers. */
  manySpeakersPrincipalUserId: string;
  /** The adapter's own contribution to the turn, built for the window's last message. */
  inputs: (context: WindowContext) => WindowTurnInputs;
}

/** What the adapter is given to build its inputs from. */
export interface WindowContext {
  venue: ConversationVenue;
  /** The messages this window collected, oldest first. */
  messages: StoredConversationMessage[];
  principalUserId: string;
}

export interface RoutedWindow {
  decision: ConversationWindowDecision;
  detail?: unknown;
}

/**
 * How many messages back a window may reach for its own contents.
 */
// cm:guard bounded, and the bound is why the seq range is read rather than trusted: a window left open across a restart can have collected more than a turn should carry, and reading all of it would put an unbounded query in the drain loop.
const WINDOW_MESSAGE_CAP = 50;

/**
 * Route one claimed window and close it under what was decided.
 */
// cm:guard EVERY path out of here closes the window, including the ones that throw: a window left open under a lapsed claim is re-claimed later and routed again, which is the double answer the claim exists to prevent — so the close is the function's post-condition and not a step in its happy path (ISS-1004 rule 1).
export async function routeWindow(args: RouteWindowArgs): Promise<RoutedWindow> {
  const { window } = args;
  const key = windowDeliveryKey(window.id);
  try {
    const result = await decide(args, key);
    await closeWindow({ windowId: window.id, decision: result.decision, detail: result.detail });
    return result;
  } catch (err) {
    // cm:guard a throw closes the window as `unreachable` rather than leaving it open to be retried for ever: the failure is recorded where a person can read it, and the room is not answered twice by a retry that finds the same fault (ISS-1004 rule 4).
    logger.error(
      { err, windowId: window.id, conversationId: window.conversationId },
      'conversations: routing a window failed',
    );
    await closeWindow({
      windowId: window.id,
      decision: 'unreachable',
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    return { decision: 'unreachable' };
  }
}

async function decide(args: RouteWindowArgs, deliveryKey: string): Promise<RoutedWindow> {
  const { window } = args;

  // cm:guard the delivery key is checked BEFORE the guards and before the turn: a window re-claimed after its holder died may already have been answered, and running the turn again to find out would cost a turn and post a second reply to discover the first one landed (ISS-1004 rule 2).
  if (await deliveredUnderKey(window.conversationId, deliveryKey)) {
    return { decision: 'answered', detail: { deliveryKey, alreadyDelivered: true } };
  }

  // cm:guard a reservation with no delivered row is the fourth state and NOT a licence to try again: the previous holder handed the text to the transport and died before it could say how that went, so the room may or may not be holding this answer already. Sending again to find out is how one reply becomes two, and calling it a failure is what rule 4 forbids outright (ISS-1004, review F2).
  if (window.deliveryReservedAt) {
    return {
      decision: 'undetermined',
      detail: {
        deliveryKey,
        reservedAt: window.deliveryReservedAt.toISOString(),
        reason: 'a delivery was handed to the transport and its outcome was never recorded',
      },
    };
  }

  const conversation = await getConversation(window.conversationId);
  if (!conversation) {
    return { decision: 'unreachable', detail: { reason: 'the conversation no longer exists' } };
  }

  const all = await readMessages(window.conversationId, WINDOW_MESSAGE_CAP);
  const messages = all.filter((m) => m.seq >= window.firstSeq && m.seq <= window.lastSeq);
  if (messages.length === 0) {
    return { decision: 'unreachable', detail: { reason: 'the window holds no readable message' } };
  }

  const venue: ConversationVenue = {
    adapter: conversation.adapter,
    externalId: conversation.externalId,
    shape: conversation.shape,
    projectId: window.projectId,
    title: conversation.title,
  };

  // cm:guard the same authority rule the collector applied, re-read from the stored rows rather than carried in memory: a one-to-one venue runs as the person who spoke, and where the collector could not name them there is nobody for this turn to be, which is a refusal and not a default (ISS-987).
  const last = messages[messages.length - 1];
  const speaker = [...messages].reverse().find((m) => m.role === 'user') ?? last;
  let principalUserId = args.manySpeakersPrincipalUserId;
  if (venue.shape === 'direct') {
    if (!speaker?.authorUserId) {
      return {
        decision: 'authority-refused',
        detail: { reason: 'the speaker in this one-to-one room is linked to no Forge user' },
      };
    }
    principalUserId = speaker.authorUserId;
  }

  const verdict = await decideProactivity({ conversationId: window.conversationId });
  if (!verdict.speak) return { decision: verdict.decision, detail: verdict.detail };

  const inputs = args.inputs({ venue, messages, principalUserId });
  const outcome = await runConversationTurn({
    ...inputs,
    venue,
    principalUserId,
    speakerKey: speaker?.authorLabel ?? speaker?.authorUserId ?? 'unknown',
    message: messages.map((m) => m.content).join('\n'),
    questionAlreadyRecorded: true,
    mayDecline: true,
    deliveryKey,
    onBeforeDeliver: () => reserveDelivery(window.id),
  });

  switch (outcome.kind) {
    case 'delivered':
      return { decision: 'answered', detail: { messageId: outcome.messageId } };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    // cm:guard a DIVERTED turn is `undetermined` and never a failure: the answer arrives by the path the adapter handed it to, and a caller that retried on this would deliver a second one (ISS-1004 rule 4).
    case 'diverted':
      return { decision: 'undetermined', detail: { reason: outcome.reason } };
    // cm:guard an `undeliverable` transport error is `undetermined` and NOT `unreachable`, because the transport does not know either: a POST that timed out may have been accepted before the socket went. `unreachable` is reserved for what this module knows BEFORE anything was sent — no conversation, no readable message, no registered transport — which is the split ISS-1004 rule 4 draws between a failure and an outcome nobody knows yet (review F3).
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}
