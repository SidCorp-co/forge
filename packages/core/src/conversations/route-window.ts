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
import { handleForProject, roomHandles } from './participants.js';
import { type ConversationVenue, codeAuthored, conversationTransport } from './ports.js';
import {
  applyRoomPresence,
  foldPresence,
  replyTargetsOf,
  windowAddressesAHandle,
} from './presence.js';
import { decideProactivity } from './proactivity.js';
import { linkedSpeakerOf } from './speaker.js';
import {
  assistantSentExternalIds,
  deliveredDecisionUnderKey,
  effectiveConversationMode,
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
  // cm:guard the wording is the SPEAKER PORT's and is asked for here rather than written here: it names the exact steps that link that account, which is ISS-977's contract and would drift the day those endpoints move. A null falls back to the neutral line below, which is true of every transport but names no way out (ISS-1004).
  refusalFor?: (speaker: {
    authorKey: string | null;
    authorLabel: string | null;
  }) => Promise<string | null> | string | null;
  /**
   * Whether a turn for this window was already handed to something that answers later.
   */
  // cm:guard asked in the RESERVED-DELIVERY branch, where the reservation is all this module can see and it cannot tell the two things a reservation means apart: a reply handed to a transport whose outcome nobody recorded, and a turn handed to a session that has not written one yet. Only the caller knows which, and without it a core that died between the dispatch and the close reopened as `undetermined` — the Forge UI's words for that are "a reply was sent and never confirmed", about an answer nobody had written (ISS-1039, plan consult F5).
  handoffFor?: (windowId: string) => Promise<{ sessionId: string } | null>;
}

/**
 * One message as a window carries it.
 */
// cm:guard re-exported HERE rather than imported from the store by the adapter: `transport-free.test.ts` fails CI on an adapter that reaches into the conversation store, and a type import is the first step of reaching in (ISS-1002, ISS-1004).
export type WindowMessage = StoredConversationMessage;

/**
 * Why this window stopped collecting, and what it covers (ISS-1086).
 */
// cm:guard handed to the adapter as a value and not re-derived there from the row: `overflow` is decided in this module after the row was claimed, so an adapter reading `window.cutReason` for itself would see `deadline` or `quiet` on a window whose head it is about to answer with the tail still collecting.
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
  // cm:guard THE fork's input, and it is on the context rather than read by the adapter because the adapter may not read the store: `transport-free.test.ts` fails CI on one that does, and this module already holds the room's row for its own reasons (ISS-1039).
  mode: ConversationMode;
  /** The messages this window collected, oldest first. */
  messages: StoredConversationMessage[];
  principalUserId: string;
  /** The Forge user the newest person message is linked to; null in a room where nobody Forge knows spoke last. */
  speakerUserId: string | null;
  /** Why the window stopped collecting and what it covers — what a turn taken mid-conversation is told (ISS-1086). */
  cut: WindowCut;
  /**
   * Make this turn's right to answer durable, for an answer this turn will not deliver itself.
   */
  // cm:guard the same reservation the delivery path takes, handed to the adapter because only the adapter knows it is about to give the answer away to a session that replies later. It answers FALSE when the claim has moved on, and the adapter must then dispatch nothing (ISS-1004, review pass 2 F1).
  reserve: () => Promise<boolean>;
}

export interface RoutedWindow {
  decision: ConversationWindowDecision;
  detail?: unknown;
  /**
   * The claim moved on under this route, so the window is another holder's now.
   */
  // cm:guard the ONE case `routeWindow` does not close: the overflow split found no row under this claim, which means another holder owns the window and its close would be theirs to write. The fence on `closeWindow` would refuse ours anyway; saying so here is what lets a test read "closes no window" off the call rather than off a no-op (ISS-1086 criteria 23, 24).
  superseded?: true;
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
  // cm:guard a row claimed before `cut_reason` existed reads as `quiet`, and that is the one absorb this module makes: it is the reading every such window had before ISS-1086, and the detail below carries the reason so a reader can tell a stamped `quiet` from an inherited one only by the row's age — which is the honest amount of information there is.
  const cut: { current: WindowCut } = {
    current: {
      reason: window.cutReason ?? 'quiet',
      coveredSeq: [window.firstSeq, window.lastSeq],
      snapshotAt: claim.claimedAt,
    },
  };
  try {
    const result = await decide(args, key, claim, cut);
    if (result.superseded) return result;
    await closeWindow({
      windowId: window.id,
      decision: result.decision,
      detail: closeDetail(window, cut.current, result.detail),
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
      detail: closeDetail(window, cut.current, {
        error: err instanceof Error ? err.message : String(err),
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
// cm:guard three numbers and not one, because the issue that added the hold asks for them apart: `collectedMs` is how long the room was made to wait for a window to be cut at all, `routingDelayMs` is how long a due window sat before a drain took it, and `replyMs` is the turn. A single latency would hide which of the three a tuning change moved (ISS-1086 criteria 25-27). `routingDelayMs` is null where the caller's row carries no `dueAt` — a number nobody measured is not written as zero.
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
): Promise<RoutedWindow> {
  const { window } = args;

  // cm:guard the delivery key is checked BEFORE the guards and before the turn: a window re-claimed after its holder died may already have been answered, and running the turn again to find out would cost a turn and post a second reply to discover the first one landed (ISS-1004 rule 2).
  const already = await deliveredDecisionUnderKey(window.conversationId, deliveryKey);
  if (already) {
    return { decision: already, detail: { deliveryKey, alreadyDelivered: true } };
  }

  // cm:guard a reservation with no delivered row is the fourth state and NOT a licence to try again: the previous holder handed the text to the transport and died before it could say how that went, so the room may or may not be holding this answer already. Sending again to find out is how one reply becomes two, and calling it a failure is what rule 4 forbids outright (ISS-1004, review F2).
  if (window.deliveryReservedAt) {
    // cm:guard the handoff is asked about FIRST, because a reservation alone cannot tell a delivery whose outcome was lost from a turn that is still being written on a box: the first is `undetermined` and the second is a session somebody can watch, and answering the second with the first's words is what put "a reply was sent and never confirmed" under a live agent turn (ISS-1039).
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

  // cm:guard OLDEST first and one past the cap: the head of the conversation is what this turn answers, and the one extra row is how overflow is detected without a count query. Reading the newest `cap` here is what silently dropped the first fifty messages of a busy room before ISS-1086 (criterion 10).
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
    // cm:guard the split is written BEFORE the turn and under the claim, and a false here ends the route with no turn and no close: the row is another holder's, and answering the head anyway would answer messages that holder is about to answer too (ISS-1086 criteria 23, 24).
    const split = await splitWindowTail({
      windowId: window.id,
      conversationId: window.conversationId,
      projectId: window.projectId,
      adapter: window.adapter,
      claim,
      prefixLastSeq: prefixLast.seq,
      // cm:guard the window's `extendedAt` IS the tail's last arrival: every inbound message bumps it, and the tail ends at the window's own `lastSeq`.
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

  // cm:guard the presence is folded from the selves of the HANDLES IN THIS ROOM, read fresh per window and never cached on the route: an admin who tightens an agent's presence expects the next window to feel it, and a room with no self on any handle folds to the very constants the guards used before (ISS-1034 criteria 32-35).
  const handles = await roomHandles(window.conversationId);
  const selves = await readSelvesFor(handles.map((h) => h.userId));
  // cm:guard ONE presence per live handle, `{}` for a handle with no self row, so the fold sees every handle in the room: a map of the rows that exist would let a handle that never wrote a self vanish from a fold whose defaults it is owed (codex F4).
  // cm:guard the ROOM's own override is applied after the fold and wins key by key: an admin who tunes a room expects it to hold whatever its handles say, and a room that set nothing takes the fold whole (ISS-1087 criteria 5, 6).
  const presence = applyRoomPresence(
    foldPresence(handles.map((h) => selves.get(h.userId)?.presence ?? {})),
    conversation.presence,
  );
  // cm:guard `mention` gates GROUP venues only and reads every message the window collected, not just the newest: a direct room is one person talking to one agent and every message is addressed to it, while in a room a person who wrote "@babo can you check" and then "the build, I mean" in two messages has named the handle once and is owed one answer (ISS-1034 criteria 66-68).
  // cm:guard a REPLY or a QUOTE of something the handle sent addresses it as plainly as its name: the targets the window carries are resolved against the handle's own delivered ids, so a reply to a person names nobody however it reads (ISS-1087 criteria 13, 14).
  if (venue.shape === 'group' && presence.answerInGroup === 'mention') {
    const names = handles.map((h) => h.handle);
    const sent = await assistantSentExternalIds(venue.adapter, replyTargetsOf(messages));
    if (!windowAddressesAHandle(messages, names, sent)) {
      return { decision: 'nothing-to-say', detail: { reason: 'not-mentioned', handles: names } };
    }
  }
  const verdict = await decideProactivity({
    conversationId: window.conversationId,
    thresholds: presence,
  });
  if (!verdict.speak) return { decision: verdict.decision, detail: verdict.detail };

  // cm:guard the SPEAKER is read separately from the PRINCIPAL and the two only coincide in a direct venue: a room runs under the org agent's authority, but the preferences a reply honours are the newest person's, and a room that read them off the principal would style every reply for the agent account (ISS-1034 criterion 19).
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
    // cm:guard `tool` is a GROUP mode like `mention`: a direct room is one person asking one agent and is owed its reply, so the mode reads as `reply` there whatever the fold says (ISS-1087 criterion 21).
    sendMode: venue.shape === 'group' && presence.answerInGroup === 'tool' ? 'tool' : 'reply',
    deliveryKey,
    onBeforeDeliver: () => reserveDelivery(window.id, claim),
  });

  switch (outcome.kind) {
    case 'delivered':
      return { decision: 'answered', detail: { messageId: outcome.messageId } };
    case 'declined':
      return { decision: 'nothing-to-say', detail: { reason: outcome.reason } };
    // cm:guard a DIVERTED turn is `handed-off` and never a failure: the answer arrives by the path the adapter handed it to, and a caller that retried on this would deliver a second one (ISS-1004 rule 4). It was `undetermined` until ISS-1039, which is a different claim — that a delivery was started and its outcome lost — and the Forge UI prints that claim in those words under every live agent turn.
    case 'diverted':
      return { decision: 'handed-off', detail: { reason: outcome.reason } };
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
