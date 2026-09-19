import type { SpeakerResolution } from '../assistant/identity/speaker-link.js';
import type { ConversationAdapter, ConversationShape } from '../db/schema-conversations.js';
import type { DoorId, MessageVerdict } from '../messaging/contract.js';
import { problemsOf } from '../messaging/contract.js';
import { type ProvenMessage, proven, wholeAgentText } from '../messaging/proven.js';

export interface ConversationVenue {
  adapter: ConversationAdapter;
  externalId: string;
  shape: ConversationShape;
  projectId: string;
  title?: string | null;
}

export interface DeliveryReceipt {
  /** The transport's own id for the posted message, or null when it named none. */
  messageId: string | null;
  /**
   * The text as the transport posted it, where that differs from the text it was handed.
   */
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
export type RequestAck =
  | { kind: 'received'; messageId: string; on: boolean }
  | { kind: 'working'; on: boolean };

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant';
  authorLabel: string | null;
  content: string;
}

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
  acknowledge?(venue: ConversationVenue, ack: RequestAck): Promise<void>;
  /**
   * Whether this venue is still reachable, asked BEFORE expensive work rather than instead of `deliver`.
   */
  canDeliver?(venue: ConversationVenue): Promise<boolean>;
  /**
   * Tell whoever is watching this venue that it has settled — after the row committed, not before.
   */
  notifySettled?(venue: ConversationVenue): Promise<void>;
  shapeFollowsMembership?: boolean;
  venueScope?(externalId: string): string | null;
}

/** The inbound half: typed to the transport's own frame, so it is called where that frame exists. */
export interface ConversationInbound<Frame> {
  resolveVenue(frame: Frame): Promise<ConversationVenue | null>;
  resolveSpeaker(frame: Frame): Promise<SpeakerResolution>;
}

export type ConversationAdapterPorts<Frame> = ConversationTransport & ConversationInbound<Frame>;

const transports = new Map<ConversationAdapter, ConversationTransport>();

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
