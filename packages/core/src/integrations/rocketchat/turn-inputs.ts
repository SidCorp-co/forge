/**
 * What Rocket.Chat contributes to a conversation turn: the seed context, the
 * toolset, the images, and the two points at which this transport hands a turn
 * to a slower path instead of answering it here.
 *
 * The turn itself belongs to `conversations/turn-runner.ts`. Everything in this
 * file is an input to it or a diversion from it — which is the whole of what an
 * adapter owes a turn (ISS-1002).
 *
 * The subject is a WINDOW of messages rather than the single message that named
 * the bot, because since ISS-1004 there is no such message: a turn answers
 * everything that arrived together, and the seed has to be told about all of it
 * or it hands the model back the rest of its own question.
 */

import { eq } from 'drizzle-orm';
import { ESCALATE_TOOL_NAME } from '../../assistant/tools/escalate.js';
import {
  buildExternalMcpToolsets,
  type ExternalMcpToolsets,
} from '../../assistant/tools/external-mcp.js';
import { codeAuthored } from '../../conversations/ports.js';
import type { WindowTurnInputs } from '../../conversations/route-window.js';
import type { TurnInputs, TurnReply } from '../../conversations/turn-runner.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  AGENT_CHAT_DEDUP_REPLY,
  AGENT_CHAT_NO_DEVICE_REPLY,
  startAgentChat,
} from './agent-chat.js';
import { readRocketChatAnswerMode } from './answer-mode.js';
import { buildConversationContext } from './context.js';
import {
  ESCALATION_ACK,
  ESCALATION_DEDUP_REPLY,
  ESCALATION_NO_DEVICE_REPLY,
  startEscalation,
} from './escalation.js';
import { prepareFastTurn } from './images.js';
import { rocketChatPersona } from './persona.js';
import type { RocketChatImageRef, RocketChatRestAuth } from './rest-client.js';
import type { RoomShape } from './room-shape.js';
import type { Route } from './routes.js';

/** What the turn needs of the connection it arrived on. */
export interface TurnBot {
  botName: string;
  serverUrl: string;
  authToken: string;
  botUserId: string;
}

/** The messages one window collected, in the terms this transport needs them in. */
export interface RocketChatTurnSubject {
  rid: string;
  tmid: string | undefined;
  /** Everything the window collected, as one body — what the diversions and the quote scan read. */
  text: string;
  /** Who spoke last, for the persona. */
  username: string | undefined;
  /** Rocket.Chat's own ids for the collected messages, oldest first. */
  messageIds: readonly string[];
  /** Every image reference the window carried. */
  images: readonly RocketChatImageRef[];
}

export interface RocketChatTurnArgs {
  bot: TurnBot;
  route: Route;
  subject: RocketChatTurnSubject;
  connectionId: string;
  shape: RoomShape;
  webBaseUrl: string | undefined;
  /**
   * Make this turn's right to answer durable before a dispatch somebody else finishes.
   */
  beforeDivert?: () => Promise<boolean>;
}

/** Everything the neutral turn takes bar what the window and its venue settle. */
export type RocketChatTurn = WindowTurnInputs;

interface Seed {
  persona: string;
  conversationContext: string | null;
  agentConfig: unknown;
  repoPath: string | null;
}

/**
 * Build the request the neutral runner takes for one Rocket.Chat message.
 */
export function rocketChatTurn(args: RocketChatTurnArgs): RocketChatTurn {
  const { bot, route, subject } = args;
  const restAuth: RocketChatRestAuth = {
    serverUrl: bot.serverUrl,
    authToken: bot.authToken,
    userId: bot.botUserId,
  };
  let seed: Seed | undefined;
  let external: ExternalMcpToolsets | undefined;

  const readSeed = async (): Promise<Seed> => {
    if (seed) return seed;
    const [conversationContext, projectRow] = await Promise.all([
      buildConversationContext(restAuth, {
        rid: subject.rid,
        tmid: subject.tmid,
        excludeMessageIds: subject.messageIds,
        triggerText: subject.text,
      }),
      db
        .select({ agentConfig: projects.agentConfig, repoPath: projects.repoPath })
        .from(projects)
        .where(eq(projects.id, route.projectId))
        .limit(1),
    ]);
    seed = {
      conversationContext,
      agentConfig: projectRow[0]?.agentConfig ?? null,
      repoPath: projectRow[0]?.repoPath ?? null,
      persona: rocketChatPersona(route.projectName, subject.username, {
        projectSlug: route.projectSlug,
        webBaseUrl: args.webBaseUrl,
        botName: bot.botName,
      }),
    };
    return seed;
  };

  const project = { id: route.projectId, slug: route.projectSlug };

  return {
    door: 'chat-sync',
    handleName: bot.botName,
    log: {
      connectionId: args.connectionId,
      rid: subject.rid,
      msgIds: subject.messageIds,
      projectId: route.projectId,
    },

    divertBeforeTurn: async ({ setPhase }): Promise<TurnReply | null> => {
      setPhase('context');
      const s = await readSeed();
      if (readRocketChatAnswerMode(s.agentConfig) !== 'agent') return null;
      setPhase('agent-chat');
      if (args.beforeDivert && !(await args.beforeDivert()))
        return { send: false, reason: 'superseded-before-agent-chat' };
      const started = await startAgentChat({
        projectId: route.projectId,
        project: { ...project, repoPath: s.repoPath },
        connectionId: args.connectionId,
        rid: subject.rid,
        tmid: subject.tmid,
        botName: bot.botName,
        message: subject.text,
        askedByUsername: subject.username,
        persona: s.persona,
        conversationContext: s.conversationContext,
      });
      if (started.started) return { send: false, reason: 'agent-chat-dispatched' };
      if (started.reason === 'deduped')
        return { send: true, message: codeAuthored(AGENT_CHAT_DEDUP_REPLY(bot.botName)) };
      if (started.reason === 'no-device')
        return { send: true, message: codeAuthored(AGENT_CHAT_NO_DEVICE_REPLY(bot.botName)) };
      return { send: false, reason: 'agent-chat-dispatch-failed' };
    },

    prepare: async ({
      setPhase,
      principalUserId,
      speakerUserId,
      conversationId,
      handleUserId,
    }): Promise<TurnInputs> => {
      const s = await readSeed();
      setPhase('mcp');
      external = await buildExternalMcpToolsets(s.agentConfig);
      setPhase('images');
      const fast = await prepareFastTurn({
        route,
        principalUserId,
        turn: { conversationId, speakerUserId, handleUserId },
        restAuth,
        rid: subject.rid,
        images: subject.images,
        externalToolsets: external.toolsets,
      });
      return {
        tools: fast.tools,
        images: fast.images,
        resolveImage: fast.resolveImage,
        persona: s.persona,
        conversationContext: s.conversationContext,
      };
    },

    divertAfterTurn: async (result, { setPhase, principalUserId }): Promise<TurnReply | null> => {
      const escalateCall = result.toolCalls.find((t) => t.name === ESCALATE_TOOL_NAME);
      if (!escalateCall) return null;
      setPhase('escalate');
      if (args.beforeDivert && !(await args.beforeDivert()))
        return { send: false, reason: 'superseded-before-escalation' };
      const s = await readSeed();
      const started = await startEscalation({
        projectId: route.projectId,
        project: { ...project, repoPath: s.repoPath },
        connectionId: args.connectionId,
        rid: subject.rid,
        tmid: subject.tmid,
        botName: bot.botName,
        question: escalationQuestion(escalateCall.arguments, subject.text),
        askedByUsername: subject.username,
        shape: args.shape,
        principalUserId,
      });
      if (started.started)
        return { send: true, message: codeAuthored(ESCALATION_ACK(bot.botName)) };
      if (started.reason === 'deduped')
        return { send: true, message: codeAuthored(ESCALATION_DEDUP_REPLY(bot.botName)) };
      if (started.reason === 'no-device')
        return { send: true, message: codeAuthored(ESCALATION_NO_DEVICE_REPLY(bot.botName)) };
      return { send: false, reason: 'escalation-dispatch-failed' };
    },

    dispose: async () => {
      await external?.dispose();
    },
  };
}

function escalationQuestion(rawArguments: string, fallback: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as { question?: unknown };
    if (typeof parsed.question === 'string' && parsed.question.trim())
      return parsed.question.trim();
  } catch {}
  return fallback;
}
