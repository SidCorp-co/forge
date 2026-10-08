// What the Forge UI contributes to a turn: the Agent-mode diversion, and in Assistant mode the
// persona and toolset the room's subject calls for.

import { eq } from 'drizzle-orm';
import { agentRefusalText } from '../agent-sessions/index.js';
import {
  askerLanguageOf,
  type ConversationImage,
  type ConversationVenue,
  type ConversationWindowRow,
  codeAuthored,
  getConversation,
  languageOfTag,
  type ReplyLanguage,
  readMessages,
  readRoomDocumentByName,
  readRoomDocumentByRef,
} from '../conversations/index.js';
import type { TurnAuthority } from '../credentials/turn-credential.js';
import { db } from '../db/client.js';
import type { ConversationMode } from '../db/schema-conversations.js';
import { requirements } from '../db/schema-requirements.js';
import { firstRequirementsOnboardingOf } from '../onboarding/index.js';
import { readContentLanguage } from '../project-config/index.js';
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
import { buildOfferActToolset } from './tools/offer-act-tool.js';
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

    continueEntry: () => {
      const rest = args.progress.next();
      return {
        onTurnEvent: rest.onTurnEvent,
        onSettled: rest.onSettled,
        replyEntry: (deliveredText) => ({
          id: rest.entryId,
          blocks: rest.blocksForRecord(deliveredText),
        }),
        close: () => rest.close(),
      };
    },

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
 * What the thread is shown when an Agent turn has no answer to give it, in the asker's language.
 */
const WEB_AGENT_REPLIES = {
  en: {
    dedup:
      'This conversation already has an Agent turn running. Wait for it to answer, or open another conversation to ask something else in parallel.',
    noDevice:
      'No paired device is free to take this turn right now. Try again in a few minutes, or open a new conversation in Assistant mode for anything that does not need the repository.',
    failed:
      'The Agent session ended without an answer. Ask again — a new turn starts a fresh session — or open a conversation in Assistant mode if the question does not need the repository.',
    ack: null,
  },
  vi: {
    dedup:
      'Cuộc trò chuyện này đang có một lượt Agent chạy. Bạn chờ nó trả lời, hoặc mở cuộc trò chuyện khác để hỏi song song việc khác.', // i18n-allow: user-facing channel reply
    noDevice:
      'Hiện không có máy đã ghép nào rảnh để nhận lượt này. Bạn thử lại sau ít phút, hoặc mở cuộc trò chuyện mới ở chế độ Assistant cho những gì không cần đến mã nguồn.', // i18n-allow: user-facing channel reply
    failed:
      'Phiên Agent đã kết thúc mà chưa có câu trả lời. Bạn hỏi lại — lượt mới sẽ mở phiên mới — hoặc mở cuộc trò chuyện ở chế độ Assistant nếu câu hỏi không cần đến mã nguồn.', // i18n-allow: user-facing channel reply
    ack: null,
  },
} as const;

const ATTACHMENT_UNREADABLE = {
  en: (file: string) =>
    `I could not send ${file} to the box that answers in Agent mode, so I have not answered rather than answering without it. Attach it again, or ask in Assistant mode, where I read it here.`,
  vi: (file: string) =>
    `Mình không gửi được ${file} tới máy trả lời ở chế độ Agent, nên chưa trả lời thay vì trả lời khi thiếu nó. Bạn đính kèm lại, hoặc hỏi ở chế độ Assistant, nơi mình đọc được tệp ngay tại đây.`, // i18n-allow: user-facing channel reply
} as const;

const ATTACHMENT_NAMELESS = { en: 'the file you attached', vi: 'tệp bạn đính kèm' } as const; // i18n-allow: user-facing channel reply

/**
 * The language a code-written line answers in: the question's where it can be told, else the
 * project's content language. A short question with no Vietnamese letter ("ok", "chay ISS-5") is
 * not taken for English.
 */
async function askerLineLanguage(args: WebTurnArgs): Promise<ReplyLanguage> {
  return (
    askerLanguageOf(args.window.question) ??
    languageOfTag((await readContentLanguage(args.project.id)).contentLanguage)
  );
}

/** Agent mode: the turn is dispatched to a paired device, or the thread is told why it was not. */
async function divertToAgent(
  args: WebTurnArgs,
  setPhase: (phase: string) => void,
  authority: TurnAuthority,
): Promise<TurnReply | null> {
  if (args.window.mode !== 'agent' || authority.origin === 'onboarding_handoff') return null;
  setPhase('agent-turn');
  const language = await askerLineLanguage(args);
  const replies = WEB_AGENT_REPLIES[language];
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
    persona: webAgentConversationPersona(args.project, args.askedBy),
    door: 'web-agent-completion',
    replies,
    ackAfterMs: null,
  });
  if (started.started) return { send: false, reason: 'agent-turn-dispatched' };
  const text =
    started.reason === 'deduped'
      ? replies.dedup
      : started.reason === 'no-device'
        ? replies.noDevice
        : started.reason === 'runner-outdated' || started.reason === 'authority-refused'
          ? agentRefusalText(started, language)
          : started.reason === 'attachment-unreadable'
            ? ATTACHMENT_UNREADABLE[language](started.file ?? ATTACHMENT_NAMELESS[language])
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
  // the token is minted while the room is read; a venue refusal still wins over what minting says
  const minting = credential();
  minting.catch(() => undefined);
  const room = await getConversation(conversationId);
  // a hand-off turn acts only in its first-requirements room; anywhere else it is refused
  const venueRefusal =
    authority.origin === 'onboarding_handoff' ? handoffVenueRefusal(room?.externalId) : null;
  if (venueRefusal) throw turnOriginRefused(venueRefusal);
  const ctx = buildChatToolContext({
    credential: await minting,
    projectSlug: args.project.slug,
    turn: {
      conversationId,
      speakerUserId,
      handleUserId,
      ecosystemId: room?.ecosystemId ?? null,
      readDocument: (file) => readRoomDocumentByName(conversationId, file),
    },
  });
  const resolveDocument = (file: ConversationImage) =>
    readRoomDocumentByRef(conversationId, file.ref);
  // a room opened about a requirement answers through the BA door: its persona and its
  // narrow tool set only, never the project toolset or the UI actions
  if (room?.requirementId) {
    const key = await requirementKeyOf(room.requirementId);
    return {
      persona: baDoorPersona(args.project.name, key, args.askedBy),
      resolveImage: makeConversationImageResolver(conversationId),
      resolveDocument,
      tools: buildBaToolset(ctx, { projectId: args.project.id, requirementId: room.requirementId }),
    };
  }
  const onboardingId = firstRequirementsOnboardingOf(room?.externalId);
  if (onboardingId) {
    return {
      persona: baFirstRequirementsPersona(args.project.name, args.askedBy),
      resolveImage: makeConversationImageResolver(conversationId),
      resolveDocument,
      tools: fenceToolsetToOrigin(
        buildBaFirstRequirementsToolset(ctx, { projectId: args.project.id, onboardingId }),
        authority.origin,
      ),
    };
  }
  return {
    persona: webConversationPersona(args.project.name, args.project.slug, args.askedBy),
    resolveImage: makeConversationImageResolver(conversationId),
    resolveDocument,
    pageContext: uiSnapshotPageContext(conversationId),
    tools: mergeToolsets(
      buildProjectToolset(ctx),
      buildUiActionToolset(),
      buildOfferActToolset({
        projectId: args.project.id,
        userId: authority.userId,
        language: await askerLineLanguage(args),
      }),
    ),
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
