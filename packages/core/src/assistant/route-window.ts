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

import {
  type ConversationVenue,
  type ConversationWindowRow,
  claimOf,
  closeWindow,
  newRequestTrack,
  type StoredConversationMessage,
  settleContinuedWindow,
  statusAfterThrow,
  windowDeliveryKey,
} from '../conversations/index.js';
import type { TurnAuthority } from '../credentials/turn-credential.js';
import type {
  ConversationMode,
  ConversationWindowCutReason,
  ConversationWindowDecision,
} from '../db/schema-conversations.js';
import { logger } from '../lib/logger.js';
import type { ContinuedRest, TurnOutcome } from './turn-request.js';
import type { ConversationTurnRequest } from './turn-runner.js';
import { decide } from './window-decision.js';
import { routedOutcome } from './window-outcome.js';

/** Everything the neutral runner takes bar what the window itself settles. */
export type WindowTurnInputs = Omit<
  ConversationTurnRequest,
  | 'venue'
  | 'authority'
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
  /** The person whose message this turn answers, as they may be acted as (ISS-17). */
  authority: TurnAuthority;
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
  /** The turn posted a partial reply and works on: the window closes, its record waits on this. */
  continuation?: ContinuedRest;
  /** Settles once the continued turn's rest is written onto the closed window's record. */
  continued?: Promise<void>;
}

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
    if (!result.continuation) return result;
    return { ...result, continued: recordContinuation(window, claim, result.continuation) };
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

const UNSETTLED = Symbol('unsettled');

/**
 * A window closes on a partial reply so the room is not held for the rest of the turn, but its
 * record stays open until the rest settles: the rest's decision, and the blocks it drew that nobody
 * will see, are written onto it. It is waited on until `until` — the turn's ceiling from its start,
 * the grace a handle is given past its abort, and the grace its delivery is given — and a rest that
 * has not settled by then is written as unsettled rather than left reading `continuing` for ever.
 */
async function recordContinuation(
  window: RouteWindowArgs['window'],
  claim: NonNullable<ReturnType<typeof claimOf>>,
  continuation: ContinuedRest,
): Promise<void> {
  const where = { windowId: window.id, conversationId: window.conversationId };
  try {
    const settled = await settledBy(continuation.rest, continuation.until);
    const continued =
      settled === UNSETTLED
        ? {
            decision: 'undetermined',
            reason: 'the rest of the turn had not settled by the bound its record waits for',
            unsettledAt: continuation.until.toISOString(),
          }
        : continuedOf(settled);
    if (!(await settleContinuedWindow({ windowId: window.id, claim, continued }))) {
      logger.warn(
        { ...where, continued },
        'conversations: the rest of a continued turn found no open record on its window',
      );
    }
  } catch (err) {
    logger.error({ err, ...where }, 'conversations: the rest of a continued turn was not recorded');
  }
}

function continuedOf(outcome: TurnOutcome): Record<string, unknown> {
  const { decision, detail } = routedOutcome(outcome);
  return {
    decision,
    ...(detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {}),
  };
}

/** The rest's outcome if it settles by `until`, else {@link UNSETTLED}. */
function settledBy(
  rest: Promise<TurnOutcome>,
  until: Date,
): Promise<TurnOutcome | typeof UNSETTLED> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(UNSETTLED), Math.max(0, until.getTime() - Date.now()));
    t.unref?.();
    rest.then(
      (outcome) => {
        clearTimeout(t);
        resolve(outcome);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
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
