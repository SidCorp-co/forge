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
import { readSelvesFor } from '../orgs/agent-selves.js';
import { handleForProject, roomHandles } from './participants.js';
import { type ConversationVenue, codeAuthored, conversationTransport } from './ports.js';
import { foldPresence, windowNamesAHandle } from './presence.js';
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
  | 'handleUserId'
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
  refusalFor?: (speaker: {
    authorKey: string | null;
    authorLabel: string | null;
  }) => Promise<string | null> | string | null;
}

/**
 * One message as a window carries it.
 */
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
  reserve: () => Promise<boolean>;
}

export interface RoutedWindow {
  decision: ConversationWindowDecision;
  detail?: unknown;
}

/**
 * How many messages back a window may reach for its own contents.
 */
const WINDOW_MESSAGE_CAP = 50;

/**
 * Route one claimed window and close it under what was decided.
 */
export async function routeWindow(args: RouteWindowArgs): Promise<RoutedWindow> {
  const { window } = args;
  const key = windowDeliveryKey(window.id);
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

  const already = await deliveredDecisionUnderKey(window.conversationId, deliveryKey);
  if (already) {
    return { decision: already, detail: { deliveryKey, alreadyDelivered: true } };
  }

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

  const handles = await roomHandles(window.conversationId);
  const selves = await readSelvesFor(handles.map((h) => h.userId));
  const presence = foldPresence(handles.map((h) => selves.get(h.userId)?.presence ?? {}));
  if (venue.shape === 'group' && presence.answerInGroup === 'mention') {
    const names = handles.map((h) => h.handle);
    if (!windowNamesAHandle(messages, names)) {
      return { decision: 'nothing-to-say', detail: { reason: 'not-mentioned', handles: names } };
    }
  }
  const verdict = await decideProactivity({
    conversationId: window.conversationId,
    thresholds: presence,
  });
  if (!verdict.speak) return { decision: verdict.decision, detail: verdict.detail };

  const speakerUserId = linkedSpeakerOf(messages).userId;
  const handleUserId = await handleForProject(window.conversationId, venue.projectId);
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
    handleUserId,
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
    case 'diverted':
      return { decision: 'undetermined', detail: { reason: outcome.reason } };
    case 'superseded':
      return { decision: 'undetermined', detail: { reason: outcome.reason, superseded: true } };
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}

/**
 * What a one-to-one room is told when nobody can be answered as.
 */
export const AUTHORITY_REFUSED_REPLY =
  'I cannot answer in this room: the account speaking here is not linked to a Forge user, so there is nobody for me to act as. Link your chat account to your Forge account and ask again.';

/**
 * Refuse a one-to-one room by name, durably and at most once.
 */
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
  const text =
    (await args.refusalFor?.(speaker ?? { authorKey: null, authorLabel: null })) ??
    AUTHORITY_REFUSED_REPLY;
  if (!(await reserveDelivery(window.id, claim))) {
    return { decision: 'undetermined', detail: { ...detail, superseded: true } };
  }
  try {
    const receipt = await transport.deliver(venue, codeAuthored(text));
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
    logger.error(
      { err, windowId: window.id, adapter: venue.adapter, externalId: venue.externalId },
      'conversations: the authority refusal could not be delivered',
    );
    return { decision: 'undetermined', detail: { ...detail, told: false, attempted: true } };
  }
}
