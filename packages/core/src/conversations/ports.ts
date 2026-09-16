// What a transport has to supply for a conversation to happen on it: four
// ports and nothing else.
//
// Two of them are inbound and typed to the transport's own message frame —
// which venue this is, and who spoke. Two are outbound and neutral, so a caller
// holding only a venue can reach a room it knows nothing about; those two are
// what the registry serves.

import type { SpeakerResolution } from '../assistant/identity/speaker-link.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';

/** Where a conversation happens, in the terms its transport uses for it. */
// cm:guard the venue lives HERE and not in the store, so an adapter importing the contract it implements imports no store module at all — which is what `transport-free.test.ts` measures at zero (ISS-1002).
export interface ConversationVenue {
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  /** The project whose handle speaks here — the venue's binding, not the room's scope. */
  projectId: string;
  title?: string | null;
}

/** What a transport returns for a message it posted. */
export interface DeliveryReceipt {
  /** The transport's own id for the posted message, or null when it named none. */
  messageId: string | null;
}

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  authorLabel: string | null;
  content: string;
}

/**
 * Text that has passed a screen, carrying the screen's verdict and the exact
 * string it was passed.
 */
// cm:guard the value owns its own text and there is no way to build one around a DIFFERENT string, which is the whole point: a screen run over the option labels while the rendered message went out unscreened is the hole ISS-978's review found, and a verdict that travels beside the text rather than inside it cannot close it.
export interface ScreenedMessage {
  readonly text: string;
  readonly problems: readonly string[];
}

/** Text this codebase wrote — an ack, a fallback, a refusal. It screens nothing because there is nothing to screen. */
export function codeAuthored(text: string): ScreenedMessage {
  return { text, problems: [] };
}

/** Model-written text, admitted only on an `ok` verdict over that exact string. */
export function screened(
  text: string,
  verdict: { ok: boolean; problems: string[] },
): ScreenedMessage | null {
  return verdict.ok ? { text, problems: verdict.problems } : null;
}

/** The neutral half: reachable with a venue alone, which is what the registry holds. */
export interface ConversationTransport {
  readonly adapter: ConversationAdapter;
  deliver(venue: ConversationVenue, message: ScreenedMessage): Promise<DeliveryReceipt>;
  fetchHistory(venue: ConversationVenue, limit: number): Promise<ConversationHistoryMessage[]>;
  /**
   * Whether this venue is still reachable, asked BEFORE expensive work rather than instead of `deliver`.
   */
  // cm:guard it is a cheap read and never the authority: `deliver` makes the same check again at the moment it posts, and it has to, because everything between the two takes time a rebind fits inside. What this buys is that a completion bridge does not spend a failover redispatch and a screening turn producing an answer for a room that moved. Absent: the transport has nothing to lose by trying, which is the browser's case (ISS-1039, plan consult F1).
  canDeliver?(venue: ConversationVenue): Promise<boolean>;
  /**
   * Tell whoever is watching this venue that it has settled — after the row committed, not before.
   */
  // cm:guard a SECOND signal and not a substitute for `deliver`: `deliver` happens before the transcript row commits, so a reader that refetched on it alone can read the room back without the reply in it. This one is called after, and it exists because a turn answered minutes later by a session has no request left for its answer to come back on (ISS-1004 step 5 review F2, ISS-1039 plan consult F3).
  notifySettled?(venue: ConversationVenue): Promise<void>;
  /**
   * Whether a room's shape follows who is in it — both ways — or is settled
   * when its venue is first seen. Absent: settled (ISS-1034).
   */
  // cm:guard declared by the TRANSPORT and never inferred from its name, because the store names no transport: a channel whose room is a chat client's own has a shape the client decided and `assertVenueMatches` holds it to; a room Forge itself owns has nothing outside it to disagree with, and its shape may move with its members (ISS-1034 criteria 41-46).
  shapeFollowsMembership?: boolean;
}

/** The inbound half: typed to the transport's own frame, so it is called where that frame exists. */
export interface ConversationInbound<Frame> {
  resolveVenue(frame: Frame): Promise<ConversationVenue | null>;
  resolveSpeaker(frame: Frame): Promise<SpeakerResolution>;
}

export type ConversationAdapterPorts<Frame> = ConversationTransport & ConversationInbound<Frame>;

const transports = new Map<ConversationAdapter, ConversationTransport>();

// cm:guard registration is by adapter NAME and the store holds nothing else about a transport: adding a second adapter is one `registerConversationTransport` call and no change here, which is the property `transport-free.test.ts` exists to keep true (ISS-1001 criteria 34, 36).
export function registerConversationTransport(transport: ConversationTransport): void {
  transports.set(transport.adapter, transport);
}

export function conversationTransport(
  adapter: ConversationAdapter,
): ConversationTransport | undefined {
  return transports.get(adapter);
}

export function registeredConversationAdapters(): ConversationAdapter[] {
  return [...transports.keys()].sort();
}

/** Test seam — the registry is process-global by design. */
export function clearConversationTransports(): void {
  transports.clear();
}
