/**
 * What Rocket.Chat contributes to a conversation turn: the seed context, the
 * toolset, the images, and the two points at which this transport hands a turn
 * to a slower path instead of answering it here.
 *
 * The turn itself belongs to `conversations/turn-runner.ts`. Everything in this
 * file is an input to it or a diversion from it — which is the whole of what an
 * adapter owes a turn (ISS-1002).
 */

import { eq } from 'drizzle-orm';
import { ESCALATE_TOOL_NAME } from '../../assistant/tools/escalate.js';
import {
  buildExternalMcpToolsets,
  type ExternalMcpToolsets,
} from '../../assistant/tools/external-mcp.js';
import { codeAuthored } from '../../conversations/ports.js';
import type {
  ConversationTurnRequest,
  TurnInputs,
  TurnReply,
} from '../../conversations/turn-runner.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import {
  AGENT_CHAT_DEDUP_REPLY,
  AGENT_CHAT_NO_DEVICE_REPLY,
  startAgentChat,
} from './agent-chat.js';
import { readRocketChatAnswerMode } from './answer-mode.js';
import { buildConversationContext } from './context.js';
import type { RocketChatIncomingMessage } from './ddp-client.js';
import {
  ESCALATION_ACK,
  ESCALATION_DEDUP_REPLY,
  ESCALATION_NO_DEVICE_REPLY,
  startEscalation,
} from './escalation.js';
import { prepareFastTurn } from './images.js';
import { rocketChatPersona } from './persona.js';
import type { RocketChatRestAuth } from './rest-client.js';
import type { RoomShape } from './room-shape.js';
import type { Route } from './routes.js';

/** What the turn needs of the connection it arrived on. */
export interface TurnBot {
  botName: string;
  serverUrl: string;
  authToken: string;
  botUserId: string;
}

export interface RocketChatTurnArgs {
  bot: TurnBot;
  route: Route;
  m: RocketChatIncomingMessage;
  connectionId: string;
  shape: RoomShape;
  webBaseUrl: string | undefined;
}

/** Everything the neutral turn takes bar what the ports and the venue's shape settle. */
export type RocketChatTurn = Omit<
  ConversationTurnRequest,
  'venue' | 'principalUserId' | 'speakerKey' | 'message'
>;

interface Seed {
  persona: string;
  conversationContext: string | null;
  agentConfig: unknown;
  repoPath: string | null;
}

/**
 * Build the request the neutral runner takes for one Rocket.Chat message.
 */
// cm:guard the seed is read ONCE and shared by both diversions and the model turn: agent mode, escalation and the fast path all need the same persona and the same room context, and re-reading it per branch is three round trips for one answer.
export function rocketChatTurn(args: RocketChatTurnArgs): RocketChatTurn {
  const { bot, route, m } = args;
  const restAuth: RocketChatRestAuth = {
    serverUrl: bot.serverUrl,
    authToken: bot.authToken,
    userId: bot.botUserId,
  };
  let seed: Seed | undefined;
  let external: ExternalMcpToolsets | undefined;

  // cm:why the turn is seeded with the recent room discussion, and the full thread when threaded, because deeper recall stays agentic through the bounded history tool rather than being paid for on every turn (ISS-609).
  const readSeed = async (): Promise<Seed> => {
    if (seed) return seed;
    const [conversationContext, projectRow] = await Promise.all([
      buildConversationContext(restAuth, {
        rid: m.rid,
        tmid: m.tmid,
        excludeMessageId: m.id,
        triggerText: m.text,
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
      persona: rocketChatPersona(route.projectName, m.username, {
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
    log: { connectionId: args.connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId },

    // cm:guard `agent` mode routes the WHOLE turn to a runner-hosted session and sends nothing but an ack synchronously — the reply lands later through the completion bridge (ISS-727).
    divertBeforeTurn: async ({ setPhase }): Promise<TurnReply | null> => {
      setPhase('context');
      const s = await readSeed();
      if (readRocketChatAnswerMode(s.agentConfig) !== 'agent') return null;
      setPhase('agent-chat');
      const started = await startAgentChat({
        projectId: route.projectId,
        project: { ...project, repoPath: s.repoPath },
        connectionId: args.connectionId,
        rid: m.rid,
        tmid: m.tmid,
        botName: bot.botName,
        message: m.text,
        askedByUsername: m.username,
        persona: s.persona,
        conversationContext: s.conversationContext,
      });
      // cm:guard send NOTHING when the dispatch started: only a genuinely slow turn gets an interim ack, scheduled by startAgentChat itself (scheduleDelayedAck). Acking here would put a promise in front of an answer that usually arrives first.
      if (started.started) return { send: false, reason: 'agent-chat-dispatched' };
      if (started.reason === 'deduped')
        return { send: true, message: codeAuthored(AGENT_CHAT_DEDUP_REPLY(bot.botName)) };
      if (started.reason === 'no-device')
        return { send: true, message: codeAuthored(AGENT_CHAT_NO_DEVICE_REPLY(bot.botName)) };
      // cm:guard 'dispatch-failed' sends nothing either — the session was created then marked failed, so the completion bridge already delivers the one honest fallback over REST; replying here too double-posts.
      return { send: false, reason: 'agent-chat-dispatch-failed' };
    },

    prepare: async ({ setPhase, principalUserId }): Promise<TurnInputs> => {
      const s = await readSeed();
      setPhase('mcp');
      external = await buildExternalMcpToolsets(s.agentConfig);
      setPhase('images');
      const fast = await prepareFastTurn({
        route,
        principalUserId,
        restAuth,
        rid: m.rid,
        images: m.images,
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

    // cm:guard escalation short-circuits the screen deliberately: the ACK it posts is code-authored, and the real follow-up lands through the completion bridge (ISS-675).
    divertAfterTurn: async (result, { setPhase, principalUserId }): Promise<TurnReply | null> => {
      const escalateCall = result.toolCalls.find((t) => t.name === ESCALATE_TOOL_NAME);
      if (!escalateCall) return null;
      setPhase('escalate');
      const s = await readSeed();
      const started = await startEscalation({
        projectId: route.projectId,
        project: { ...project, repoPath: s.repoPath },
        connectionId: args.connectionId,
        rid: m.rid,
        tmid: m.tmid,
        botName: bot.botName,
        question: escalationQuestion(escalateCall.arguments, m.text),
        askedByUsername: m.username,
        shape: args.shape,
        principalUserId,
      });
      if (started.started)
        return { send: true, message: codeAuthored(ESCALATION_ACK(bot.botName)) };
      if (started.reason === 'deduped')
        return { send: true, message: codeAuthored(ESCALATION_DEDUP_REPLY(bot.botName)) };
      if (started.reason === 'no-device')
        return { send: true, message: codeAuthored(ESCALATION_NO_DEVICE_REPLY(bot.botName)) };
      // cm:guard same as agent mode: on 'dispatch-failed' the bridge delivers the single fallback, so this turn must post nothing.
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
  } catch {
    // cm:why a malformed tool-call argument is not worth failing the turn over — the escalation still carries the user's own message text, which is what a research agent needs
  }
  return fallback;
}
