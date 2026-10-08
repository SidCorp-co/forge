// What a session carries in its metadata when its answer belongs to a conversation, and the one
// reader of it. Light on purpose: the question origin and the thread marks read it without loading
// the turn machinery.

import { readSessionAsker, type SessionAsker } from '@forge/contracts/agent-sessions';
import type { MemberLens } from '../db/schema.js';
import { type DroppedBlock, type StagedBlock, stagedBlocksOf } from '../lib/staged-block.js';
import type { ConversationVenue } from './ports.js';
import type { ConversationImage } from './store.js';

/** The metadata key a session carries when its answer belongs to a conversation. */
export const CONVERSATION_AGENT_MARKER = 'conversationAgent';

/** What the venue is shown when this lane has no model answer to give it. */
interface ConversationAgentReplies {
  /** A turn is already running in this room. */
  dedup: string;
  /** No device could take it. */
  noDevice: string;
  /** It ran and produced nothing this venue can be shown. */
  failed: string;
  /** Posted only if the turn is still running after `ackAfterMs`; null sends none. */
  ack: string | null;
}

export interface ConversationAgentTurnArgs {
  venue: ConversationVenue;
  /** The room, its window, and the stable key this window's one delivery answers. */
  conversationId: string;
  windowId: string;
  deliveryKey: string;
  project: { id: string; slug: string };
  /** The handle answering here — whose voice the code-authored sentences speak in. */
  handleName: string;
  /** Everything the window collected, as one body. */
  question: string;
  askedByLabel?: string | null | undefined;
  /** The person whose message this turn answers; the session runs as them (ISS-17). */
  asker: SessionAsker;
  persona: string;
  conversationContext?: string | null | undefined;
  /** Where the reply is screened when it comes back. */
  door: 'agent-chat-completion' | 'web-agent-completion';
  replies: ConversationAgentReplies;
  /** How long a still-running turn waits before its ack is posted; null posts none. */
  ackAfterMs?: number | null | undefined;
  /** The chat voice this session's cold-start preamble is pinned to. */
  forceLenses?: readonly MemberLens[] | null | undefined;
  /**
   * The pictures the window's messages carry. A box reads its own session's
   * attachments and nothing of the room's, so each one is copied onto this
   * turn's session before the turn is dispatched (ISS-1146).
   */
  images?: readonly ConversationImage[] | undefined;
}

export type ConversationAgentTurnResult =
  | { started: true; sessionId: string }
  | {
      started: false;
      reason:
        | 'deduped'
        | 'no-device'
        | 'runner-outdated'
        | 'dispatch-failed'
        | 'attachment-unreadable'
        | 'authority-refused';
      /** The file the turn could not carry, for a refusal that names it. */
      file?: string;
      /** On `authority-refused`: why, in the words the room is shown. */
      message?: string;
    };

/** One rule the reply screen held a session's reply on, as the screen named it. */
export interface HeldRefusal {
  rule: string;
  why: string;
  quote: string | null;
  /** The rule, as one plain sentence. */
  shape: string;
}

/**
 * A reply the session wrote and the door's screen would not pass: kept, not lost, so the asker can
 * still read it and the session page names the rules that held it.
 */
export interface HeldReply {
  at: string;
  text: string;
  refusals: HeldRefusal[];
  /** The blocks the session drew for this reply: held with it, never posted into the room. */
  blocks: StagedBlock[];
}

/** Why the screen held a reply, as one plain sentence per rule it broke. */
export function heldBecause(refusals: readonly HeldRefusal[]): string {
  const rules = [...new Map(refusals.map((r) => [r.rule, r])).values()];
  if (rules.length === 0) return 'The reply check held it without naming a rule.';
  return rules.map((r) => `It broke the rule "${r.shape}" (${r.rule}).`).join(' ');
}

/** What a session carries about the conversation turn it is answering. */
export interface ConversationAgentMeta {
  venue: ConversationVenue;
  conversationId: string;
  windowId: string;
  deliveryKey: string;
  handleName: string;
  question: string;
  askedByLabel: string | null;
  /** Who asked: the person this session acts as, read again by a failover. */
  asker: SessionAsker | null;
  door: 'agent-chat-completion' | 'web-agent-completion';
  replies: ConversationAgentReplies;
  ackAfterMs: number | null;
  /**
   * When the bridge took this turn's delivery, which is NOT when it was delivered.
   */
  claimedAt: string | null;
  deliveredAt: string | null;
  /** Which failure the venue was told about, stamped by the bridge; null while none. */
  failure: string | null;
  failover?: { attempt: number; triedDeviceIds: string[] } | undefined;
  /** The reply the screen held, where it held one; stamped by the bridge. */
  held?: HeldReply | undefined;
  /**
   * The blocks the session posted over REST, waiting on its reply: posted above it if it passes,
   * kept with it if it is held (`reports/routes.ts`, `conversation-agent-stage.ts`).
   */
  staged: StagedBlock[];
  /** Blocks the session drew that nobody will see, and why; stamped by the bridge. */
  droppedBlocks: DroppedBlock[];
  /** The pictures the turn carried, so a failover copies them onto its retry session too. */
  images: ConversationImage[];
}

function imagesOf(raw: unknown): ConversationImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is ConversationImage =>
      !!i && typeof i.name === 'string' && typeof i.mime === 'string' && typeof i.ref === 'string',
  );
}

const str = (v: unknown): v is string => typeof v === 'string';

function heldOf(raw: unknown): HeldReply | undefined {
  const h = raw as Partial<HeldReply> | null | undefined;
  if (!h || !str(h.at) || !str(h.text) || !Array.isArray(h.refusals)) return undefined;
  const refusals = h.refusals.filter(
    (r): r is HeldRefusal =>
      !!r && str(r.rule) && str(r.why) && str(r.shape) && (r.quote === null || str(r.quote)),
  );
  return { at: h.at, text: h.text, refusals, blocks: stagedBlocksOf(h.blocks) };
}

function droppedOf(raw: unknown): DroppedBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (d): d is DroppedBlock =>
      !!d && str(d.kind) && str(d.why) && (d.runId === null || str(d.runId)),
  );
}

export function readConversationAgentMeta(metadata: unknown): ConversationAgentMeta | null {
  const raw = (metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const venue = m.venue as ConversationVenue | undefined;
  if (
    !venue ||
    typeof venue.adapter !== 'string' ||
    typeof venue.externalId !== 'string' ||
    typeof venue.projectId !== 'string' ||
    typeof m.conversationId !== 'string' ||
    typeof m.windowId !== 'string' ||
    typeof m.deliveryKey !== 'string'
  ) {
    return null;
  }
  const replies = (m.replies ?? {}) as Record<string, unknown>;
  const held = heldOf(m.held);
  return {
    venue,
    conversationId: m.conversationId,
    windowId: m.windowId,
    deliveryKey: m.deliveryKey,
    handleName: typeof m.handleName === 'string' ? m.handleName : '',
    question: typeof m.question === 'string' ? m.question : '',
    askedByLabel: typeof m.askedByLabel === 'string' ? m.askedByLabel : null,
    asker: readSessionAsker(m.asker),
    door: m.door === 'web-agent-completion' ? 'web-agent-completion' : 'agent-chat-completion',
    replies: {
      dedup: typeof replies.dedup === 'string' ? replies.dedup : '',
      noDevice: typeof replies.noDevice === 'string' ? replies.noDevice : '',
      failed: typeof replies.failed === 'string' ? replies.failed : '',
      ack: typeof replies.ack === 'string' ? replies.ack : null,
    },
    ackAfterMs: typeof m.ackAfterMs === 'number' ? m.ackAfterMs : null,
    claimedAt:
      typeof m.claimedAt === 'string'
        ? m.claimedAt
        : typeof m.deliveredAt === 'string'
          ? m.deliveredAt
          : null,
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
    failure: typeof m.failure === 'string' ? m.failure : null,
    ...(m.failover ? { failover: m.failover as ConversationAgentMeta['failover'] } : {}),
    ...(held ? { held } : {}),
    staged: stagedBlocksOf(m.staged),
    droppedBlocks: droppedOf(m.droppedBlocks),
    images: imagesOf(m.images),
  };
}
