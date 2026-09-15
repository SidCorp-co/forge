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
import { type ConversationVenue, codeAuthored, conversationTransport } from './ports.js';
import { decideProactivity } from './proactivity.js';
import { linkedSpeakerOf } from './speaker.js';
import {
  deliveredDecisionUnderKey,
  getConversation,
  readMessagesInRange,
  type StoredConversationMessage,
} from './store.js';
import { recordDeliveredReply } from './transcript.js';
import { type ConversationTurnRequest, runConversationTurn } from './turn-runner.js';
import {
  type ConversationWindowRow,
  claimOf,
  closeWindow,
  reserveDelivery,
  type WindowClaim,
  windowDeliveryKey,
} from './windows.js';

/** Everything the neutral runner takes bar what the window itself settles. */
export type WindowTurnInputs = Omit<
  ConversationTurnRequest,
  | 'venue'
  | 'principalUserId'
  | 'speakerUserId'
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
  /**
   * What to tell a one-to-one room whose speaker is linked to nobody.
   */
  // cm:guard the wording is the SPEAKER PORT's and is asked for here rather than written here: it names the exact steps that link that account, which is ISS-977's contract and would drift the day those endpoints move. A null falls back to the neutral line below, which is true of every transport but names no way out (ISS-1004).
  refusalFor?: (speaker: {
    authorKey: string | null;
    authorLabel: string | null;
  }) => Promise<string | null> | string | null;
}

/**
 * One message as a window carries it.
 */
// cm:guard re-exported HERE rather than imported from the store by the adapter: `transport-free.test.ts` fails CI on an adapter that reaches into the conversation store, and a type import is the first step of reaching in (ISS-1002, ISS-1004).
export type WindowMessage = StoredConversationMessage;

/** What the adapter is given to build its inputs from. */
export interface WindowContext {
  venue: ConversationVenue;
  /** The messages this window collected, oldest first. */
  messages: StoredConversationMessage[];
  principalUserId: string;
  /** The Forge user the newest person message is linked to; null in a room where nobody Forge knows spoke last. */
  speakerUserId: string | null;
  /**
   * Make this turn's right to answer durable, for an answer this turn will not deliver itself.
   */
  // cm:guard the same reservation the delivery path takes, handed to the adapter because only the adapter knows it is about to give the answer away to a session that replies later. It answers FALSE when the claim has moved on, and the adapter must then dispatch nothing (ISS-1004, review pass 2 F1).
  reserve: () => Promise<boolean>;
}

export interface RoutedWindow {
  decision: ConversationWindowDecision;
  detail?: unknown;
}

/**
 * How many messages back a window may reach for its own contents.
 */
// cm:guard bounded, and the bound is why the window READS its own seq range in SQL rather than filtering the conversation tail: a window left open across a restart can have collected more than a turn should carry, and an unbounded query in the drain loop is what this cap is for (ISS-1004, review pass 1 F4).
const WINDOW_MESSAGE_CAP = 50;

/**
 * Route one claimed window and close it under what was decided.
 */
// cm:guard EVERY path out of here closes the window, including the ones that throw: a window left open under a lapsed claim is re-claimed later and routed again, which is the double answer the claim exists to prevent — so the close is the function's post-condition and not a step in its happy path (ISS-1004 rule 1).
export async function routeWindow(args: RouteWindowArgs): Promise<RoutedWindow> {
  const { window } = args;
  const key = windowDeliveryKey(window.id);
  // cm:guard a window arriving here unclaimed is a caller error and not a case to absorb: every write below is fenced on the claim, and an absent one would fence on nothing and let two holders settle the same window (ISS-1004, review pass 1 F1).
  const claim = claimOf(window);
  if (!claim)
    throw new Error('conversations: a window is routed under its claim, and this one holds none');
  try {
    const result = await decide(args, key, claim);
    await closeWindow({
      windowId: window.id,
      decision: result.decision,
      detail: result.detail,
      claim,
    });
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
      claim,
    });
    return { decision: 'unreachable' };
  }
}

async function decide(
  args: RouteWindowArgs,
  deliveryKey: string,
  claim: WindowClaim,
): Promise<RoutedWindow> {
  const { window } = args;

  // cm:guard the delivery key is checked BEFORE the guards and before the turn: a window re-claimed after its holder died may already have been answered, and running the turn again to find out would cost a turn and post a second reply to discover the first one landed (ISS-1004 rule 2).
  const already = await deliveredDecisionUnderKey(window.conversationId, deliveryKey);
  if (already) {
    return { decision: already, detail: { deliveryKey, alreadyDelivered: true } };
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

  const messages = await readMessagesInRange(window.conversationId, {
    firstSeq: window.firstSeq,
    lastSeq: window.lastSeq,
    limit: WINDOW_MESSAGE_CAP,
  });
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
      return refuseAuthority(args, venue, window, deliveryKey, claim, {
        authorKey: speaker?.authorKey ?? null,
        authorLabel: speaker?.authorLabel ?? null,
      });
    }
    principalUserId = speaker.authorUserId;
  }

  const verdict = await decideProactivity({ conversationId: window.conversationId });
  if (!verdict.speak) return { decision: verdict.decision, detail: verdict.detail };

  // cm:guard the SPEAKER is read separately from the PRINCIPAL and the two only coincide in a direct venue: a room runs under the org agent's authority, but the preferences a reply honours are the newest person's, and a room that read them off the principal would style every reply for the agent account (ISS-1034 criterion 19).
  const speakerUserId = linkedSpeakerOf(messages).userId;
  const inputs = args.inputs({
    venue,
    messages,
    principalUserId,
    speakerUserId,
    reserve: () => reserveDelivery(window.id, claim),
  });
  const outcome = await runConversationTurn({
    ...inputs,
    venue,
    principalUserId,
    speakerUserId,
    speakerKey: speaker?.authorLabel ?? speaker?.authorUserId ?? 'unknown',
    message: messages.map((m) => m.content).join('\n'),
    questionAlreadyRecorded: true,
    mayDecline: true,
    deliveryKey,
    onBeforeDeliver: () => reserveDelivery(window.id, claim),
  });

  switch (outcome.kind) {
    case 'delivered':
      return { decision: 'answered', detail: { messageId: outcome.messageId } };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    // cm:guard a DIVERTED turn is `undetermined` and never a failure: the answer arrives by the path the adapter handed it to, and a caller that retried on this would deliver a second one (ISS-1004 rule 4).
    case 'diverted':
      return { decision: 'undetermined', detail: { reason: outcome.reason } };
    // cm:guard a SUPERSEDED turn writes nothing anyone reads, and it is `undetermined` only so this function has one shape: the close that follows is fenced on the same lapsed claim and applies to nothing, which is the point — the holder that took the window over is the one whose decision lands (ISS-1004, review pass 1 F1).
    case 'superseded':
      return { decision: 'undetermined', detail: { reason: outcome.reason, superseded: true } };
    // cm:guard an `undeliverable` transport error is `undetermined` and NOT `unreachable`, because the transport does not know either: a POST that timed out may have been accepted before the socket went. `unreachable` is reserved for what this module knows BEFORE anything was sent — no conversation, no readable message, no registered transport — which is the split ISS-1004 rule 4 draws between a failure and an outcome nobody knows yet (review F3).
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}

/**
 * What a one-to-one room is told when nobody can be answered as.
 */
// cm:guard the FALLBACK, used only when `RouteWindowArgs.refusalFor` names nothing — an adapter that supplies none, or a speaker the row kept no transport key for. It names the generic remedy — link the account — and deliberately not the endpoints that do it, because those are the speaker port's to name and a copy here would drift the day they move; this module asks for that wording rather than holding one (ISS-987, ISS-1004).
export const AUTHORITY_REFUSED_REPLY =
  'I cannot answer in this room: the account speaking here is not linked to a Forge user, so there is nobody for me to act as. Link your chat account to your Forge account and ask again.';

/**
 * Refuse a one-to-one room by name, durably and at most once.
 */
// cm:guard the refusal is DELIVERED and not merely decided, and it goes out under the window's own delivery key with the reservation before it: `authority-refused` used to be a decision nobody outside the database could read, so a person whose synchronous refusal failed to send was left with silence and nothing retryable behind it (ISS-1004, review pass 1 F3).
async function refuseAuthority(
  args: RouteWindowArgs,
  venue: ConversationVenue,
  window: ConversationWindowRow,
  deliveryKey: string,
  claim: WindowClaim,
  speaker?: { authorKey: string | null; authorLabel: string | null },
): Promise<RoutedWindow> {
  const detail = { reason: 'the speaker in this one-to-one room is linked to no Forge user' };
  const transport = conversationTransport(venue.adapter);
  if (!transport) return { decision: 'authority-refused', detail: { ...detail, told: false } };
  // cm:guard the wording is settled BEFORE the reservation and the reservation immediately before the send: `refusalFor` asks a directory, so it can fail or hang, and a reservation burned by a lookup that sent nothing leaves the window `undetermined` for good with the person never told (ISS-1004, review of the plan F1).
  const text =
    (await args.refusalFor?.(speaker ?? { authorKey: null, authorLabel: null })) ??
    AUTHORITY_REFUSED_REPLY;
  if (!(await reserveDelivery(window.id, claim))) {
    return { decision: 'undetermined', detail: { ...detail, superseded: true } };
  }
  try {
    const receipt = await transport.deliver(venue, codeAuthored(text));
    // cm:guard the proof says WHICH decision sent it, so a crash before the close cannot be read as an ordinary answer: without it the next claimant saw a delivery, knew nothing of what it was, and wrote `answered` over a room that had been refused (ISS-1004 rule 4).
    await recordDeliveredReply({
      conversationId: window.conversationId,
      projectId: window.projectId,
      text,
      receipt,
      deliveryKey,
      decision: 'authority-refused',
    });
    return { decision: 'authority-refused', detail: { ...detail, told: true } };
  } catch (err) {
    // cm:guard a refusal the door would not take is `undetermined` and NOT `authority-refused`: the window stays a record that nobody was told, and the reservation above is what stops the next claim saying it twice (ISS-1004 rule 4).
    logger.error(
      { err, windowId: window.id, adapter: venue.adapter, externalId: venue.externalId },
      'conversations: the authority refusal could not be delivered',
    );
    return { decision: 'undetermined', detail: { ...detail, told: false, attempted: true } };
  }
}
