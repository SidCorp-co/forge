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

import type {
  ConversationMode,
  ConversationWindowCutReason,
  ConversationWindowDecision,
} from '../db/schema-conversations.js';
import { logger } from '../logger.js';
import { readSelvesFor } from '../orgs/agent-selves.js';
import { acknowledgeRequest } from './acknowledgement.js';
import { refuseAuthority } from './authority-refusal.js';
import { handleForProject, personCount, roomHandles } from './participants.js';
import { type ConversationVenue, conversationTransport } from './ports.js';
import {
  applyRoomPresence,
  foldPresence,
  replyTargetsOf,
  windowAddressesAHandle,
} from './presence.js';
import { decideProactivity } from './proactivity.js';
import {
  explicitAnchor,
  newRequestTrack,
  type RequestTrack,
  statusAfterThrow,
  withTerminalStatus,
} from './request-status.js';
import { linkedSpeakerOf } from './speaker.js';
import {
  assistantSentExternalIds,
  deliveredDecisionUnderKey,
  effectiveConversationMode,
  getConversation,
  readMessagesInRange,
  type StoredConversationMessage,
} from './store.js';
import {
  type ConversationTurnRequest,
  runConversationTurn,
  type TurnOutcome,
} from './turn-runner.js';
import {
  type ConversationWindowRow,
  claimOf,
  closeWindow,
  reserveDelivery,
  splitWindowTail,
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
  | 'sendMode'
  | 'fallbacks'
  | 'addressee'
  | 'deliveryKey'
  | 'onBeforeDeliver'
>;

export interface RouteWindowArgs {
  /** The claimed row; `dueAt` rides along from the claim where the caller has one, and is what `routingDelayMs` is measured from. */
  window: ConversationWindowRow & { dueAt?: Date | undefined };
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
  /**
   * Whether a turn for this window was already handed to something that answers later.
   */
  handoffFor?: (windowId: string) => Promise<{ sessionId: string } | null>;
}

/**
 * One message as a window carries it.
 */
export type WindowMessage = StoredConversationMessage;

/**
 * Why this window stopped collecting, and what it covers (ISS-1086).
 */
export interface WindowCut {
  reason: ConversationWindowCutReason;
  /** The seq range this turn answers, inclusive. */
  coveredSeq: readonly [number, number];
  /** When the range was fixed — the claim. */
  snapshotAt: Date;
}

/** What the adapter is given to build its inputs from. */
export interface WindowContext {
  venue: ConversationVenue;
  /** The room this window is in — what a diversion hands to whatever answers later. */
  conversationId: string;
  /** This window's own id, and the stable key its one delivery answers. */
  windowId: string;
  deliveryKey: string;
  /**
   * What this room answers in, read off the room rather than off any project's config.
   */
  mode: ConversationMode;
  /** The messages this window collected, oldest first. */
  messages: StoredConversationMessage[];
  principalUserId: string;
  /** The Forge user the newest person message is linked to; null in a room where nobody Forge knows spoke last. */
  speakerUserId: string | null;
  cut: WindowCut;
  /**
   * Make this turn's right to answer durable, for an answer this turn will not deliver itself.
   */
  reserve: () => Promise<boolean>;
}

export interface RoutedWindow {
  decision: ConversationWindowDecision;
  detail?: unknown;
  /**
   * The claim moved on under this route, so the window is another holder's now.
   */
  superseded?: true;
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
  const cut: { current: WindowCut } = {
    current: {
      reason: window.cutReason ?? 'quiet',
      coveredSeq: [window.firstSeq, window.lastSeq],
      snapshotAt: claim.claimedAt,
    },
  };
  const track = newRequestTrack();
  try {
    const result = await decide(args, key, claim, cut, track);
    if (result.superseded) return result;
    await closeWindow({
      windowId: window.id,
      decision: result.decision,
      detail: closeDetail(window, cut.current, result.detail),
      claim,
    });
    return result;
  } catch (err) {
    logger.error(
      { err, windowId: window.id, conversationId: window.conversationId },
      'conversations: routing a window failed',
    );
    const status = await statusAfterThrow(window, key, claim, track);
    await closeWindow({
      windowId: window.id,
      decision: 'unreachable',
      detail: closeDetail(window, cut.current, {
        error: err instanceof Error ? err.message : String(err),
        ...(status ? { status } : {}),
      }),
      claim,
    });
    return { decision: 'unreachable' };
  }
}

/**
 * What every close records beside the decision: the cut, and the three durations
 * the hold is judged by.
 */
function closeDetail(
  window: RouteWindowArgs['window'],
  cut: WindowCut,
  detail: unknown,
  now: Date = new Date(),
): Record<string, unknown> {
  const claimedAt = window.claimedAt ?? now;
  return {
    ...(detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {}),
    cut: cut.reason,
    coveredSeq: cut.coveredSeq,
    collectedMs: claimedAt.getTime() - window.openedAt.getTime(),
    routingDelayMs: window.dueAt ? claimedAt.getTime() - window.dueAt.getTime() : null,
    replyMs: now.getTime() - claimedAt.getTime(),
  };
}

async function decide(
  args: RouteWindowArgs,
  deliveryKey: string,
  claim: WindowClaim,
  cut: { current: WindowCut },
  track: RequestTrack,
): Promise<RoutedWindow> {
  const { window } = args;

  const already = await deliveredDecisionUnderKey(window.conversationId, deliveryKey);
  if (already) {
    return { decision: already, detail: { deliveryKey, alreadyDelivered: true } };
  }

  if (window.deliveryReservedAt) {
    const handed = await args.handoffFor?.(window.id);
    if (handed) {
      return {
        decision: 'handed-off',
        detail: {
          deliveryKey,
          sessionId: handed.sessionId,
          reservedAt: window.deliveryReservedAt.toISOString(),
          reason: 'this turn is running as a session on a paired device; its reply arrives later',
        },
      };
    }
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

  const collected = await readMessagesInRange(window.conversationId, {
    firstSeq: window.firstSeq,
    lastSeq: window.lastSeq,
    limit: WINDOW_MESSAGE_CAP + 1,
    order: 'oldest-first',
  });
  if (collected.length === 0) {
    return { decision: 'unreachable', detail: { reason: 'the window holds no readable message' } };
  }
  let messages = collected;
  if (collected.length > WINDOW_MESSAGE_CAP) {
    const head = collected.slice(0, WINDOW_MESSAGE_CAP);
    const prefixLast = head[head.length - 1] as StoredConversationMessage;
    const tailFirst = collected[WINDOW_MESSAGE_CAP] as StoredConversationMessage;
    const split = await splitWindowTail({
      windowId: window.id,
      conversationId: window.conversationId,
      projectId: window.projectId,
      adapter: window.adapter,
      claim,
      prefixLastSeq: prefixLast.seq,
      tail: {
        firstSeq: tailFirst.seq,
        lastSeq: window.lastSeq,
        firstAt: tailFirst.createdAt,
        lastAt: window.extendedAt,
      },
    });
    if (!split) {
      return {
        decision: 'undetermined',
        detail: { reason: 'the claim moved on before the overflow split', superseded: true },
        superseded: true,
      };
    }
    messages = head;
    cut.current = {
      reason: 'overflow',
      coveredSeq: [window.firstSeq, prefixLast.seq],
      snapshotAt: claim.claimedAt,
    };
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
  const presence = applyRoomPresence(
    foldPresence(handles.map((h) => selves.get(h.userId)?.presence ?? {})),
    conversation.presence,
  );
  const names = handles.map((h) => h.handle);
  const targets = venue.shape === 'group' ? replyTargetsOf(messages) : [];
  const sent =
    targets.length > 0
      ? await assistantSentExternalIds(
          venue.adapter,
          handles.map((h) => h.userId),
          targets,
          conversationTransport(venue.adapter)?.venueScope?.(venue.externalId) ?? null,
        )
      : new Set<string>();
  if (venue.shape === 'group' && presence.answerInGroup === 'mention') {
    if (!windowAddressesAHandle(messages, names, sent)) {
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
    conversationId: window.conversationId,
    windowId: window.id,
    deliveryKey,
    mode: effectiveConversationMode(conversation),
    messages,
    principalUserId,
    speakerUserId,
    cut: cut.current,
    reserve: () => reserveDelivery(window.id, claim),
  });
  const anchor = explicitAnchor(venue, messages, names, sent);
  const transport = conversationTransport(venue.adapter);
  track.anchor = anchor;
  track.venue = venue;
  track.handleName = inputs.handleName;
  const addressee =
    anchor && venue.shape === 'group' && (await personCount(window.conversationId)) > 1
      ? anchor.authorLabel
      : null;
  const ack = anchor
    ? acknowledgeRequest({ transport, venue, anchor, log: { windowId: window.id } })
    : null;
  let outcome: TurnOutcome;
  try {
    outcome = await runConversationTurn({
      ...inputs,
      venue,
      principalUserId,
      speakerUserId,
      handleUserId,
      speakerKey: speaker?.authorLabel ?? speaker?.authorUserId ?? 'unknown',
      message: messages.map((m) => m.content).join('\n'),
      questionAlreadyRecorded: true,
      mayDecline: true,
      sendMode: venue.shape === 'group' && presence.answerInGroup === 'tool' ? 'tool' : 'reply',
      fallbacks: venue.shape === 'group' ? 'silence' : 'post',
      addressee,
      deliveryKey,
      onBeforeDeliver: () => reserveDelivery(window.id, claim),
    });
  } finally {
    await ack?.settle();
  }

  return withTerminalStatus(routedOutcome(outcome), { window, deliveryKey, claim, track });
}

/** The decision a turn's outcome closes the window under. */
function routedOutcome(outcome: TurnOutcome): RoutedWindow {
  switch (outcome.kind) {
    case 'delivered':
      return { decision: 'answered', detail: { messageId: outcome.messageId } };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    case 'stopped':
      return { decision: 'stopped', detail: { reason: outcome.reason } };
    case 'diverted':
      return { decision: 'handed-off', detail: { reason: outcome.reason } };
    case 'superseded':
      return { decision: 'undetermined', detail: { reason: outcome.reason, superseded: true } };
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}
