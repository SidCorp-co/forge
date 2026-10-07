// What the Forge UI contributes to a turn: the Agent-mode diversion, and in Assistant mode the
// persona and toolset the room's subject calls for.

import { eq } from 'drizzle-orm';
import { agentRefusalText } from '../agent-sessions/index.js';
import {
  type ConversationImage,
  type ConversationVenue,
  type ConversationWindowRow,
  codeAuthored,
  getConversation,
  readMessages,
} from '../conversations/index.js';
import type { TurnAuthority } from '../credentials/turn-credential.js';
import { db } from '../db/client.js';
import type { ConversationMode } from '../db/schema-conversations.js';
import { requirements } from '../db/schema-requirements.js';
import { firstRequirementsOnboardingOf } from '../onboarding/index.js';
import { makeConversationImageResolver } from './conversation-images.js';
import type { ConversationProgress } from './conversation-progress.js';
import {
  baDoorPersona,
  baFirstRequirementsPersona,
  webAgentConversationPersona,
  webConversationPersona,
} from './door-persona.js';
import type { WindowTurnInputs } from './route-window.js';
import { buildBaFirstRequirementsToolset } from './tools/ba-first-tools.js';
import { buildBaToolset } from './tools/ba-tools.js';
import { mergeToolsets } from './tools/mcp-adapter.js';
import { buildChatToolContext } from './tools/principal.js';
import { buildProjectToolset } from './tools/registry.js';
import { buildUiActionToolset } from './tools/ui-actions-tool.js';
import { fenceToolsetToOrigin, handoffVenueRefusal, turnOriginRefused } from './turn-origin.js';
import type { TurnHookContext, TurnInputs, TurnReply } from './turn-request.js';
import { uiSnapshotPageContext } from './ui-snapshot.js';

interface WebTurnArgs {
  project: { id: string; slug: string; name: string };
  handleName: string;
  askedBy: string | null;
  /** The window this turn answers, for the diversion that answers later. */
  window: {
    venue: ConversationVenue;
    conversationId: string;
    windowId: string;
    deliveryKey: string;
    mode: ConversationMode;
    question: string;
    /** The pictures this window's messages carry, for a turn answered on a box. */
    images: readonly ConversationImage[];
    /**
     * What was said in this room BEFORE this window, for a turn answered out of reach.
     */
    conversationContext: () => Promise<string | null>;
    reserve: () => Promise<boolean>;
  };
  /**
   * The watcher this turn publishes to while it runs.
   */
  progress: ConversationProgress;
  /** A person ending this turn from the room it runs in. */
  externalStop: AbortSignal;
}

/**
 * What the Forge UI contributes to a turn: who the assistant is, and what it may read.
 */
export function webConversationTurn(args: WebTurnArgs): WindowTurnInputs {
  return {
    door: 'web-chat-reply',
    // the conversation list reads "Waiting on you" from the reply row, so every Assistant-mode
    // turn here is offered `await_reply` (ISS-277); an Agent-mode turn is diverted before it runs
    recordsAsks: true,
    externalStop: args.externalStop,
    handleName: args.handleName,
    log: { adapter: 'web', projectId: args.project.id, mode: args.window.mode },

    onTurnEvent: args.progress.onTurnEvent,
    onSettled: args.progress.onSettled,
    replyEntry: (deliveredText) => ({
      id: args.progress.entryId,
      blocks: args.progress.blocksForRecord(deliveredText),
    }),

    divertBeforeTurn: ({ setPhase, authority }) => divertToAgent(args, setPhase, authority),
    prepare: (ctx) => prepareWebTurn(args, ctx),
  };
}

async function requirementKeyOf(requirementId: string): Promise<string> {
  const [row] = await db
    .select({ seq: requirements.reqSeq })
    .from(requirements)
    .where(eq(requirements.id, requirementId))
    .limit(1);
  return row ? `REQ-${row.seq}` : requirementId;
}

/**
 * What the thread is shown when an Agent turn has no answer to give it.
 */
const WEB_AGENT_REPLIES = {
  dedup:
    'This conversation already has an Agent turn running. Wait for it to answer, or open another conversation to ask something else in parallel.',
  noDevice:
    'No paired device is free to take this turn right now. Try again in a few minutes, or open a new conversation in Assistant mode for anything that does not need the repository.',
  failed:
    'The Agent session ended without an answer. Ask again — a new turn starts a fresh session — or open a conversation in Assistant mode if the question does not need the repository.',
  ack: null,
} as const;

/** Agent mode: the turn is dispatched to a paired device, or the thread is told why it was not. */
async function divertToAgent(
  args: WebTurnArgs,
  setPhase: (phase: string) => void,
  authority: TurnAuthority,
): Promise<TurnReply | null> {
  if (args.window.mode !== 'agent' || authority.origin === 'onboarding_handoff') return null;
  setPhase('agent-turn');
  if (!(await args.window.reserve()))
    return { send: false, reason: 'superseded-before-agent-turn', ended: 'superseded' };
  const { startConversationAgentTurn } = await import('../conversations/index.js');
  const started = await startConversationAgentTurn({
    venue: args.window.venue,
    conversationId: args.window.conversationId,
    windowId: args.window.windowId,
    deliveryKey: args.window.deliveryKey,
    project: { id: args.project.id, slug: args.project.slug },
    handleName: args.handleName,
    question: args.window.question,
    askedByLabel: args.askedBy,
    asker: authority,
    conversationContext: await args.window.conversationContext(),
    ...(args.window.images.length ? { images: args.window.images } : {}),
    persona: webAgentConversationPersona(args.project.name, args.project.slug, args.askedBy),
    door: 'web-agent-completion',
    replies: WEB_AGENT_REPLIES,
    ackAfterMs: null,
  });
  if (started.started) return { send: false, reason: 'agent-turn-dispatched' };
  const text =
    started.reason === 'deduped'
      ? WEB_AGENT_REPLIES.dedup
      : started.reason === 'no-device'
        ? WEB_AGENT_REPLIES.noDevice
        : started.reason === 'runner-outdated' || started.reason === 'authority-refused'
          ? agentRefusalText(started)
          : started.reason === 'attachment-unreadable'
            ? `I could not send ${started.file ?? 'the file you attached'} to the box that answers in Agent mode, so I have not answered rather than answering without it. Attach it again, or ask in Assistant mode, where I read it here.`
            : null;
  if (text === null)
    return { send: false, reason: 'agent-turn-dispatch-failed', ended: 'not-dispatched' };
  return { send: true, message: codeAuthored(text), screenReplaced: false };
}

/** Assistant mode: the persona and toolset the room's subject calls for. */
async function prepareWebTurn(
  args: WebTurnArgs,
  { credential, speakerUserId, conversationId, handleUserId, authority }: TurnHookContext,
): Promise<TurnInputs> {
  const room = await getConversation(conversationId);
  // a hand-off turn acts only in its first-requirements room; anywhere else it is refused
  const venueRefusal =
    authority.origin === 'onboarding_handoff' ? handoffVenueRefusal(room?.externalId) : null;
  if (venueRefusal) throw turnOriginRefused(venueRefusal);
  const ctx = buildChatToolContext({
    credential: await credential(),
    projectSlug: args.project.slug,
    turn: { conversationId, speakerUserId, handleUserId, ecosystemId: room?.ecosystemId ?? null },
  });
  // a room opened about a requirement answers through the BA door: its persona and its
  // narrow tool set only, never the project toolset or the UI actions
  if (room?.requirementId) {
    const key = await requirementKeyOf(room.requirementId);
    return {
      persona: baDoorPersona(args.project.name, key, args.askedBy),
      resolveImage: makeConversationImageResolver(conversationId),
      tools: buildBaToolset(ctx, { projectId: args.project.id, requirementId: room.requirementId }),
    };
  }
  const onboardingId = firstRequirementsOnboardingOf(room?.externalId);
  if (onboardingId) {
    return {
      persona: baFirstRequirementsPersona(args.project.name, args.askedBy),
      resolveImage: makeConversationImageResolver(conversationId),
      tools: fenceToolsetToOrigin(
        buildBaFirstRequirementsToolset(ctx, { projectId: args.project.id, onboardingId }),
        authority.origin,
      ),
    };
  }
  return {
    persona: webConversationPersona(args.project.name, args.project.slug, args.askedBy),
    resolveImage: makeConversationImageResolver(conversationId),
    pageContext: uiSnapshotPageContext(conversationId),
    tools: mergeToolsets(buildProjectToolset(ctx), buildUiActionToolset()),
  };
}

/**
 * How many earlier messages a diverted turn is handed.
 */
const AGENT_CONTEXT_MESSAGES = 20;

export async function agentConversationContext(
  window: ConversationWindowRow,
): Promise<string | null> {
  const before = (await readMessages(window.conversationId, AGENT_CONTEXT_MESSAGES + 1)).filter(
    (m) => m.seq < window.firstSeq,
  );
  if (before.length === 0) return null;
  return before
    .slice(-AGENT_CONTEXT_MESSAGES)
    .map((m) => `${m.authorLabel ?? (m.role === 'assistant' ? 'Assistant' : m.role)}: ${m.content}`)
    .join('\n');
}
