// What a transport has to supply for a conversation to happen on it: four
// ports and nothing else.
//
// Two of them are inbound and typed to the transport's own message frame —
// which venue this is, and who spoke. Two are outbound and neutral, so a caller
// holding only a venue can reach a room it knows nothing about; those two are
// what the registry serves.

import type { SpeakerResolution } from '../assistant/identity/speaker-link.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import type { DoorId, MessageVerdict } from '../messaging/contract.js';
import { problemsOf } from '../messaging/contract.js';
import { type ProvenMessage, proven, wholeAgentText } from '../messaging/proven.js';

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
  /**
   * The text as the transport posted it, where that differs from the text it was handed.
   */
  // cm:guard set ONLY by a transport that changed the text on the way out — the `@label` address a Rocket.Chat reply into a room of several people gets — so the transcript row holds what the room was shown and not what the screen admitted. Absent: the two are the same string (ISS-1088 criteria 21, 22).
  deliveredText?: string | undefined;
}

/** What a delivery may carry beside the text: who it answers, and what it hangs under. */
export interface DeliveryOptions {
  /** The person this reply answers, by the label the transport shows for them; the transport decides how to address them, or ignores it. */
  addressee?: string | null | undefined;
  /** The transport's id for the message this delivery answers, where it wants to attach it — a Rocket.Chat thread; ignored by a transport with no such thing. */
  anchor?: string | null | undefined;
}

/**
 * What a transport is asked to show for a request it is working on.
 */
// cm:guard the KERNEL decides when and the transport decides with what: `received` names a message and `working` names the venue, and neither says "reaction" or "typing" — a transport with no way to show one makes it a no-op, and one whose instrument notifies nobody is the only kind allowed here (ISS-1088 criterion 1).
export type RequestAck =
  | { kind: 'received'; messageId: string; on: boolean }
  | { kind: 'working'; on: boolean };

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  authorLabel: string | null;
  content: string;
}

/**
 * Text that has passed a screen, carrying the screen's proof and the exact
 * string it was passed.
 */
// cm:guard the value owns its own text and there is no way to build one around a DIFFERENT string, which is the whole point: a screen run over the option labels while the rendered message went out unscreened is the hole ISS-978's review found, and a verdict that travels beside the text rather than inside it cannot close it.
// cm:guard `proof` is what a transport posts under, and `null` on it means CODE-AUTHORED rather than
// unscreened: until ISS-978 the Rocket.Chat port inferred that from `problems.length === 0`, so a clean
// model reply was posted as a fixed constant — a claim about who wrote it, read off a field about what
// was wrong with it. A transport now reads the answer instead of guessing at it.
export interface ScreenedMessage {
  readonly text: string;
  readonly problems: readonly string[];
  /** The door's proof for `text`, or null where this codebase wrote it. */
  readonly proof: ProvenMessage | null;
}

/** Text this codebase wrote — an ack, a fallback, a refusal. It screens nothing because there is nothing to screen. */
export function codeAuthored(text: string): ScreenedMessage {
  return { text, problems: [], proof: null };
}

/** Model-written text, admitted only on an `ok` verdict over that exact string. */
// cm:guard it takes the DOOR and a real `MessageVerdict`, not a `{ ok: boolean }` a caller assembled:
// since ISS-978 the `ok` arm is nominal, so a caller reaching here with a passing verdict has run a
// screen. The old signature accepted a literal, which meant this function admitted anything anybody
// asserted about it and the guard above was a claim about nothing.
export function screened(
  text: string,
  door: DoorId,
  verdict: MessageVerdict,
): ScreenedMessage | null {
  const admitted = proven(door, wholeAgentText(text), verdict);
  return admitted ? { text, problems: problemsOf(verdict), proof: admitted } : null;
}

/** The neutral half: reachable with a venue alone, which is what the registry holds. */
export interface ConversationTransport {
  readonly adapter: ConversationAdapter;
  deliver(
    venue: ConversationVenue,
    message: ScreenedMessage,
    opts?: DeliveryOptions,
  ): Promise<DeliveryReceipt>;
  fetchHistory(venue: ConversationVenue, limit: number): Promise<ConversationHistoryMessage[]>;
  /**
   * Show the venue that a request was received, or that work on it is under way.
   */
  // cm:guard OPTIONAL and a no-op where absent, never a fallback message: a transport that cannot signal without posting has nothing here, because a post is the one thing an acknowledgement must not be — it notifies, and the person asked for an answer, not a notification about one (ISS-1088 criterion 1). Failures are the caller's to log; this rejects and never posts in its place.
  acknowledge?(venue: ConversationVenue, ack: RequestAck): Promise<void>;
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
  /**
   * The prefix every venue id on the same server as this one shares, or null
   * where the transport has one server only. Absent: one server.
   */
  // cm:guard declared by the TRANSPORT, because only it knows how its venue ids are built: a Rocket.Chat message id is unique within one installation, so a lookup that asks "did our handle post this id" has to ask it within the server the room is on, and the store reads this prefix rather than parsing an id whose shape is not its business (ISS-1087 criteria 13, 14; whole-set review F2).
  venueScope?(externalId: string): string | null;
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
