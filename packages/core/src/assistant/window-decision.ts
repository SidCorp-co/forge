// The decision a claimed window is for: a delivery already settled, the overflow split, whether
// the room addressed a handle and may be spoken in, and the one turn taken over the window.

import {
  acknowledgeRequest,
  applyRoomPresence,
  assistantSentExternalIds,
  type ConversationVenue,
  conversationTransport,
  decideProactivity,
  deliveredDecisionUnderKey,
  effectiveConversationMode,
  explicitAnchor,
  foldPresence,
  getConversation,
  groupHearing,
  handleForProject,
  linkedSpeakerOf,
  messageAuthorTokenId,
  personCount,
  type RequestTrack,
  readMessagesInRange,
  replyLanguageOf,
  replyLanguageOfTag,
  replyTargetsOf,
  reserveDelivery,
  roomHandles,
  type StoredConversationMessage,
  setRoomQuiet,
  splitWindowTail,
  type WindowClaim,
  windowAddressesAHandle,
  withTerminalStatus,
} from '../conversations/index.js';
import type { TurnAuthority } from '../credentials/turn-credential.js';
import {
  firstRequirementsOnboardingOf,
  firstRequirementsStarterOf,
  onboardingRoomOf,
} from '../onboarding/index.js';
import { readSelvesFor } from '../orgs/index.js';
import { resolveTurnAuthority } from '../permissions/index.js';
import { readContentLanguage } from '../project-config/index.js';
import { refuseAuthority } from './authority-refusal.js';
import type { RoutedWindow, RouteWindowArgs, WindowCut } from './route-window.js';
import { handoffPersonSpoke, handoffVenueRefusal } from './turn-origin.js';
import { runConversationTurn, type TurnOutcome } from './turn-runner.js';

/** How many messages back a window may reach for its own contents. */
const WINDOW_MESSAGE_CAP = 50;

type Conversation = NonNullable<Awaited<ReturnType<typeof getConversation>>>;

interface Routing {
  args: RouteWindowArgs;
  deliveryKey: string;
  claim: WindowClaim;
  cut: { current: WindowCut };
  track: RequestTrack;
}

export async function decide(
  args: RouteWindowArgs,
  deliveryKey: string,
  claim: WindowClaim,
  cut: { current: WindowCut },
  track: RequestTrack,
): Promise<RoutedWindow> {
  const r: Routing = { args, deliveryKey, claim, cut, track };
  const { window } = args;
  const prior = await priorDecision(r);
  if (prior) return prior;

  const conversation = await getConversation(window.conversationId);
  if (!conversation) {
    return { decision: 'unreachable', detail: { reason: 'the conversation no longer exists' } };
  }
  const messages = await collected(r);
  if (!Array.isArray(messages)) return messages;

  const venue: ConversationVenue = {
    adapter: conversation.adapter,
    externalId: conversation.externalId,
    shape: conversation.shape,
    projectId: window.projectId,
    title: conversation.title,
  };
  if (window.origin === 'onboarding_handoff' && !handoffPersonSpoke(messages)) {
    return handoffTurn(r, conversation, venue, messages);
  }
  const onboarding = await onboardingRoomOf(window.conversationId);
  if (onboarding) return toOnboardingJob(onboarding.live);
  const speakerOf = (said: StoredConversationMessage[]) =>
    [...said].reverse().find((m) => m.role === 'user') ?? said[said.length - 1];
  const unlinked = (who: StoredConversationMessage | undefined) =>
    refuseAuthority(args, venue, window, deliveryKey, claim, {
      authorKey: who?.authorKey ?? null,
      authorLabel: who?.authorLabel ?? null,
    });
  if (venue.shape === 'direct' && !speakerOf(messages)?.authorUserId) {
    return unlinked(speakerOf(messages));
  }

  const room = await mayRoomSpeak(r, conversation, venue, messages);
  if ('decision' in room) return room;

  // a turn acts as the person whose message it answers, in every shape; a group room
  // once ran as its handle or its org's creator, so a viewer's ask wrote with their role (ISS-17).
  // In a group room that is the person whose message was for the handle, not whoever spoke last.
  const speaker = speakerOf(room.heard);
  if (!speaker?.authorUserId) return unlinked(speaker);
  const resolved = await resolveTurnAuthority({
    userId: speaker.authorUserId,
    projectId: venue.projectId,
    viaTokenId: await messageAuthorTokenId(speaker.id),
  });
  if (!resolved.ok) {
    return refuseAuthority(args, venue, window, deliveryKey, claim, undefined, resolved.refusal);
  }
  return takeTurn(r, {
    conversation,
    venue,
    messages: room.heard,
    speaker,
    room,
    authority: resolved.authority,
  });
}

/**
 * An onboarding thread has one agent: the job that drafts the designs reads every message a person
 * writes there (`onboarding/prompt.ts:threadRequests`). A chat turn here would be a second agent
 * answering for work it does not do, so the window is handed to the job and says which.
 */
function toOnboardingJob(live: boolean): RoutedWindow {
  return {
    decision: 'handed-off',
    detail: {
      handedTo: 'onboarding-job',
      jobLive: live,
      reason: live
        ? 'the onboarding job reads this before it posts its questions'
        : 'no onboarding job runs now; the next one reads this, and a re-analysis starts one',
    },
  };
}

/**
 * project-onboarding `req-case`: the BA drafts first requirements with no person's message to answer.
 * It acts for the onboarding's starter, the person the case room is addressed to, with the origin on
 * its authority, so its tools are cut to reading the journeys and proposing suggestions; every
 * suggestion still waits on a person's accept. Outside a first-requirements room it is refused.
 */
async function handoffTurn(
  r: Routing,
  conversation: Conversation,
  venue: ConversationVenue,
  messages: StoredConversationMessage[],
): Promise<RoutedWindow> {
  const { args, deliveryKey, claim } = r;
  const { window } = args;
  const refused = (refusal: { code: string; message: string }) =>
    refuseAuthority(args, venue, window, deliveryKey, claim, undefined, refusal);
  const outside = handoffVenueRefusal(venue.externalId);
  if (outside) return refused(outside);
  const onboardingId = firstRequirementsOnboardingOf(venue.externalId) as string;
  const starter = await firstRequirementsStarterOf(onboardingId);
  if (!starter) {
    return refused({
      code: 'TURN_ORIGIN_REFUSED',
      message: `I will not draft here: the onboarding ${onboardingId} this room was opened for no longer exists.`,
    });
  }
  const room = await mayRoomSpeak(r, conversation, venue, messages);
  if ('decision' in room) return room;
  const resolved = await resolveTurnAuthority({
    userId: starter,
    projectId: venue.projectId,
    viaTokenId: null,
  });
  if (!resolved.ok) return refused(resolved.refusal);
  return takeTurn(r, {
    conversation,
    venue,
    messages,
    speaker: undefined,
    room,
    authority: { ...resolved.authority, origin: 'onboarding_handoff' },
    message: HANDOFF_MESSAGE,
  });
}

const HANDOFF_MESSAGE =
  'Onboarding hand-off: every onboarding design is approved and nobody has asked yet. Draft the first requirements now, one suggestion per approved journey, and say which journeys you suggested for and which you skipped. You may only read the journeys, look for similar requirements and suggest; a person accepts or rejects each suggestion.';

/** What a window already settled: a delivery recorded under its key, or one reserved and never recorded. */
async function priorDecision({ args, deliveryKey }: Routing): Promise<RoutedWindow | null> {
  const { window } = args;
  const already = await deliveredDecisionUnderKey(window.conversationId, deliveryKey);
  if (already) return { decision: already, detail: { deliveryKey, alreadyDelivered: true } };
  if (!window.deliveryReservedAt) return null;
  const reservedAt = window.deliveryReservedAt.toISOString();
  const handed = await args.handoffFor?.(window.id);
  if (handed) {
    return {
      decision: 'handed-off',
      detail: {
        deliveryKey,
        sessionId: handed.sessionId,
        reservedAt,
        reason: 'this turn is running as a session on a paired device; its reply arrives later',
      },
    };
  }
  return {
    decision: 'undetermined',
    detail: {
      deliveryKey,
      reservedAt,
      reason: 'a delivery was handed to the transport and its outcome was never recorded',
    },
  };
}

/** The window's messages, its overflow split off into a window of its own. */
async function collected({
  args,
  claim,
  cut,
}: Routing): Promise<StoredConversationMessage[] | RoutedWindow> {
  const { window } = args;
  const read = await readMessagesInRange(window.conversationId, {
    firstSeq: window.firstSeq,
    lastSeq: window.lastSeq,
    limit: WINDOW_MESSAGE_CAP + 1,
    order: 'oldest-first',
  });
  if (read.length === 0) {
    return { decision: 'unreachable', detail: { reason: 'the window holds no readable message' } };
  }
  if (read.length <= WINDOW_MESSAGE_CAP) return read;
  const head = read.slice(0, WINDOW_MESSAGE_CAP);
  const prefixLast = head[head.length - 1] as StoredConversationMessage;
  const tailFirst = read[WINDOW_MESSAGE_CAP] as StoredConversationMessage;
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
  cut.current = {
    reason: 'overflow',
    coveredSeq: [window.firstSeq, prefixLast.seq],
    snapshotAt: claim.claimedAt,
  };
  return head;
}

interface Room {
  presence: ReturnType<typeof applyRoomPresence>;
  names: Awaited<ReturnType<typeof roomHandles>>[number]['handle'][];
  sent: Set<string>;
  /** The window's messages the turn answers: in a group room, those meant for a handle. */
  heard: StoredConversationMessage[];
}

/** Whether the room addressed a handle and the proactivity guards let it speak. */
async function mayRoomSpeak(
  { args }: Routing,
  conversation: Conversation,
  venue: ConversationVenue,
  messages: StoredConversationMessage[],
): Promise<Room | RoutedWindow> {
  const { window } = args;
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
  let heard = messages;
  if (venue.shape === 'group') {
    const hearing = await hearGroup(window.conversationId, conversation, messages, names, sent);
    if ('decision' in hearing) return hearing;
    heard = hearing;
  }
  if (
    venue.shape === 'group' &&
    presence.answerInGroup === 'mention' &&
    !windowAddressesAHandle(heard, names, sent)
  ) {
    return { decision: 'nothing-to-say', detail: { reason: 'not-mentioned', handles: names } };
  }
  const verdict = await decideProactivity({
    conversationId: window.conversationId,
    thresholds: presence,
  });
  if (!verdict.speak) return { decision: verdict.decision, detail: verdict.detail };
  return { presence, names, sent, heard };
}

/**
 * A group room's window, read for whom it speaks to before any turn is spent: a stop request quiets
 * the room on its presence, a quiet room stays quiet until a handle is named, and messages that tag
 * only a person are theirs.
 */
async function hearGroup(
  conversationId: string,
  conversation: Conversation,
  messages: StoredConversationMessage[],
  names: Room['names'],
  sent: Set<string>,
): Promise<StoredConversationMessage[] | RoutedWindow> {
  const hearing = groupHearing(messages, names, sent, conversation.presence?.quiet);
  switch (hearing.kind) {
    case 'asked-to-stop': {
      const quiet = { since: new Date().toISOString(), by: hearing.by };
      await setRoomQuiet(conversationId, quiet);
      return {
        decision: 'nothing-to-say',
        detail: { reason: 'asked-to-stop', ...quiet, handles: names },
      };
    }
    case 'quiet-until-mentioned':
      return {
        decision: 'nothing-to-say',
        detail: { reason: 'quiet-until-mentioned', ...hearing.quiet, handles: names },
      };
    case 'addressed-to-person':
      return { decision: 'nothing-to-say', detail: { reason: 'addressed-to-person' } };
    default:
      if (hearing.liftsQuiet && conversation.presence?.quiet)
        await setRoomQuiet(conversationId, null);
      return hearing.messages;
  }
}

async function takeTurn(
  { args, deliveryKey, claim, cut, track }: Routing,
  t: {
    conversation: Conversation;
    venue: ConversationVenue;
    messages: StoredConversationMessage[];
    speaker: StoredConversationMessage | undefined;
    room: Room;
    authority: TurnAuthority;
    /** What the turn is asked; the window's messages joined, unless its origin words it. */
    message?: string;
  },
): Promise<RoutedWindow> {
  const { window } = args;
  const { venue, messages, speaker, room, authority } = t;
  const speakerUserId = linkedSpeakerOf(messages).userId;
  const handleUserId = await handleForProject(window.conversationId, venue.projectId);
  const inputs = args.inputs({
    venue,
    conversationId: window.conversationId,
    windowId: window.id,
    deliveryKey,
    mode: effectiveConversationMode(t.conversation),
    messages,
    authority,
    speakerUserId,
    cut: cut.current,
    reserve: () => reserveDelivery(window.id, claim),
  });
  const anchor = explicitAnchor(venue, messages, room.names, room.sent);
  track.anchor = anchor;
  track.venue = venue;
  track.handleName = inputs.handleName;
  track.language =
    replyLanguageOf(anchor?.text ?? speaker?.content) ??
    replyLanguageOfTag((await readContentLanguage(venue.projectId)).contentLanguage);
  const group = venue.shape === 'group';
  const addressee =
    anchor && group && (await personCount(window.conversationId)) > 1 ? anchor.authorLabel : null;
  const ack = anchor
    ? acknowledgeRequest({
        transport: conversationTransport(venue.adapter),
        venue,
        anchor,
        log: { windowId: window.id },
      })
    : null;
  let outcome: TurnOutcome;
  try {
    outcome = await runConversationTurn({
      ...inputs,
      venue,
      authority,
      speakerUserId,
      handleUserId,
      speakerKey:
        speaker?.authorLabel ??
        speaker?.authorUserId ??
        (authority.origin === 'message' ? 'unknown' : authority.origin),
      message: t.message ?? messages.map((m) => m.content).join('\n'),
      questionAlreadyRecorded: true,
      mayDecline: true,
      sendMode: group && room.presence.answerInGroup === 'tool' ? 'tool' : 'reply',
      fallbacks: group ? 'silence' : 'post',
      addressee,
      deliveryKey,
      replyLanguage: track.language,
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
      return {
        decision: 'answered',
        detail: {
          messageId: outcome.messageId,
          ...(outcome.continuation ? { continuing: true } : {}),
        },
      };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    case 'failed':
      return { decision: 'unreachable', detail: { code: outcome.code, reason: outcome.reason } };
    case 'stopped':
      return { decision: 'stopped', detail: { reason: outcome.reason } };
    case 'diverted':
      return { decision: 'handed-off', detail: { reason: outcome.reason } };
    case 'superseded':
      return { decision: 'undetermined', detail: { reason: outcome.reason, superseded: true } };
    case 'undeliverable':
      return {
        decision: 'undetermined',
        detail: {
          code: outcome.code,
          reason: outcome.reason,
          attempted: true,
          undeliveredReply: outcome.reply,
        },
      };
    default:
      return { decision: 'undetermined', detail: { reason: outcome.reason, attempted: true } };
  }
}
