/**
 * What an explicit request is owed beside its answer: the anchor it hangs on,
 * and the one line a person is told where the agent could not answer at all.
 *
 * `route-window.ts` decides the window; this module decides whether that
 * window was somebody asking, and whether they are told anything when the
 * decision is not an answer (ISS-1088). Only a turn that failed tells them, in
 * core's plain Vietnamese last-resort line, once per thread (ISS-875): a turn
 * that wrote nothing, or whose answer the reply check held, or whose delivery
 * is uncertain, is the agent's silence, and core never stands in for it.
 */

import type { ConversationWindowDecision } from '../db/schema-conversations.js';
import { reportFailure } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { claimLastResort, releaseLastResort } from './last-resort.js';
import {
  type ConversationTransport,
  type ConversationVenue,
  codeAuthored,
  conversationTransport,
  threadVenueOf,
} from './ports.js';
import { namesHandle } from './presence.js';
import type { StoredConversationMessage } from './store.js';
import { recordDeliveredReply } from './transcript.js';
import { reserveDelivery } from './window-claim.js';
import type { WindowClaim } from './windows.js';

/** The message an explicit request is anchored on: what is marked received, and what the status threads under. */
interface ExplicitAnchor {
  /** The transport's id for the message, or null where it carried none — then nothing can be marked on it. */
  messageId: string | null;
  receivedAt: Date;
  /** The label the transport shows for whoever asked. */
  authorLabel: string | null;
  /** What they asked with. */
  text: string;
}

/**
 * Whether this window is somebody asking, and which message they asked with.
 */
export function explicitAnchor(
  venue: ConversationVenue,
  messages: readonly StoredConversationMessage[],
  handles: readonly (string | null)[],
  sentByHandle: ReadonlySet<string>,
): ExplicitAnchor | null {
  const spoken = messages.filter((m) => m.role === 'user');
  const pick =
    venue.shape === 'direct'
      ? (spoken[spoken.length - 1] ?? messages[messages.length - 1])
      : [...spoken]
          .reverse()
          .find(
            (m) =>
              handles.some((h) => namesHandle(m.content, h)) ||
              (m.replyToExternalId !== null && sentByHandle.has(m.replyToExternalId)),
          );
  if (!pick) return null;
  return {
    messageId: pick.externalId,
    receivedAt: pick.createdAt,
    authorLabel: pick.authorLabel,
    text: pick.content,
  };
}

type TerminalStatus = 'turn-failed';

/**
 * Which line, if any, a routed decision owes the person who asked: the turn-failed line where the
 * turn could not answer (`unreachable`: it failed, timed out, or never ran), and nothing otherwise.
 */
function terminalStatusFor(routed: {
  decision: ConversationWindowDecision;
}): TerminalStatus | null {
  return routed.decision === 'unreachable' ? 'turn-failed' : null;
}

/** What the window's close records about the status it posted, or failed to. */
interface PostedStatus {
  status: TerminalStatus;
  anchor: string | null;
  delivered: boolean;
  reason?: string;
}

interface PostStatusArgs {
  status: TerminalStatus;
  anchor: ExplicitAnchor;
  venue: ConversationVenue;
  transport: ConversationTransport | undefined;
  conversationId: string;
  projectId: string;
  /** The window's own key, so a re-claim finds the status and neither retries the answer nor posts a second status. */
  deliveryKey: string;
  /** The decision the window closes under, carried on the row so a re-claim reads the truth back. */
  decision: ConversationWindowDecision;
  /** The window's own reservation; a false means the claim moved on and nothing is posted. */
  reserve: () => Promise<boolean>;
  log?: Record<string, unknown>;
}

/**
 * Post the one line a failed request is owed, where its thread was told none yet, and record it
 * under the window's key.
 */
async function postStatus(args: PostStatusArgs): Promise<PostedStatus> {
  const base = { status: args.status, anchor: args.anchor.messageId };
  if (!args.transport) {
    return { ...base, delivered: false, reason: 'no transport is registered for this venue' };
  }
  if (!(await args.reserve())) {
    return { ...base, delivered: false, reason: 'the claim moved on before the status was posted' };
  }
  const place = {
    adapter: args.venue.adapter,
    venue: threadVenueOf(args.transport, args.venue, args.anchor.messageId),
  };
  const text = await claimLastResort(place, 'turn_failed');
  if (!text) {
    return {
      ...base,
      delivered: false,
      reason: 'the thread was told its one last-resort line already',
    };
  }
  try {
    const receipt = await args.transport.deliver(args.venue, codeAuthored(text), {
      anchor: args.anchor.messageId,
    });
    await recordDeliveredReply({
      conversationId: args.conversationId,
      projectId: args.projectId,
      text: receipt.deliveredText ?? text,
      receipt,
      deliveryKey: args.deliveryKey,
      decision: args.decision,
    });
    return { ...base, delivered: true };
  } catch (err) {
    logger.error(
      { err, ...args.log, adapter: args.venue.adapter, externalId: args.venue.externalId },
      'conversations: the terminal status could not be delivered; nothing else will be tried',
    );
    reportFailure(err, {
      tags: { area: 'conversations', phase: 'status' },
      extra: { adapter: args.venue.adapter, externalId: args.venue.externalId, ...args.log },
    });
    await releaseLastResort(place);
    return { ...base, delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What the route knows about the request while the turn runs, for the status that follows.
 */
export interface RequestTrack {
  anchor: ExplicitAnchor | null;
  venue: ConversationVenue | null;
  /** Whether a status went out for this window already — one per window, whichever path posts it. */
  posted: boolean;
  /**
   * Whether the turn came back with an outcome, so the status question has been asked of it.
   */
  outcomeKnown: boolean;
}

export function newRequestTrack(): RequestTrack {
  return {
    anchor: null,
    venue: null,
    posted: false,
    outcomeKnown: false,
  };
}

interface WindowRef {
  id: string;
  conversationId: string;
  projectId: string;
}

/** The turn-failed line for a route that threw after it knew who was asking, once. */
export async function statusAfterThrow(
  window: WindowRef,
  deliveryKey: string,
  claim: WindowClaim,
  track: RequestTrack,
): Promise<PostedStatus | null> {
  if (!track.anchor || !track.venue || track.posted || track.outcomeKnown) {
    return null;
  }
  track.posted = true;
  try {
    return await postStatus({
      status: 'turn-failed',
      anchor: track.anchor,
      venue: track.venue,
      transport: conversationTransport(track.venue.adapter),
      conversationId: window.conversationId,
      projectId: window.projectId,
      deliveryKey,
      decision: 'unreachable',
      reserve: () => reserveDelivery(window.id, claim),
      log: { windowId: window.id },
    });
  } catch (err) {
    logger.error(
      { err, windowId: window.id },
      'conversations: the status after a throw failed too',
    );
    return null;
  }
}

/**
 * Post the status a routed decision owes, where it owes one, and fold what happened into the detail.
 */
export async function withTerminalStatus<
  T extends { decision: ConversationWindowDecision; detail?: unknown; superseded?: true },
>(
  routed: T,
  args: {
    window: WindowRef;
    deliveryKey: string;
    claim: WindowClaim;
    track: RequestTrack;
  },
): Promise<T> {
  const { track } = args;
  track.outcomeKnown = true;
  if (!track.anchor || !track.venue || track.posted) return routed;
  const status = terminalStatusFor(routed);
  if (!status) return routed;
  track.posted = true;
  const posted = await postStatus({
    status,
    anchor: track.anchor,
    venue: track.venue,
    transport: conversationTransport(track.venue.adapter),
    conversationId: args.window.conversationId,
    projectId: args.window.projectId,
    deliveryKey: args.deliveryKey,
    decision: routed.decision,
    reserve: () => reserveDelivery(args.window.id, args.claim),
    log: { windowId: args.window.id },
  });
  const detail = routed.detail && typeof routed.detail === 'object' ? routed.detail : {};
  return { ...routed, detail: { ...(detail as Record<string, unknown>), status: posted } };
}
