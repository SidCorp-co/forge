/**
 * What Rocket.Chat contributes to a conversation turn: the seed context, the
 * toolset, the images, and the point after it at which this transport hands a
 * turn to a slower path instead of answering it here.
 *
 * The turn itself belongs to `assistant/turn-runner.ts`. Everything in this
 * file is an input to it or a diversion from it — which is the whole of what an
 * adapter owes a turn (ISS-1002).
 *
 * The subject is a WINDOW of messages rather than the single message that named
 * the bot, because since ISS-1004 there is no such message: a turn answers
 * everything that arrived together, and the seed has to be told about all of it
 * or it hands the model back the rest of its own question.
 */

import { ESCALATE_TOOL_NAME } from '@forge/contracts/assistant';
import { agentRefusalText } from '../../agent-sessions/index.js';
import { type ConversationVenue, codeAuthored } from '../../conversations/index.js';
import type {
  RocketChatImageRef,
  RocketChatRestAuth,
  RoomShape,
  Route,
} from '../../integrations/rocketchat/index.js';
import type { WindowCut, WindowTurnInputs } from '../route-window.js';
import type { TurnInputs, TurnReply } from '../turn-runner.js';
import { buildConversationContext } from './context.js';
import {
  ESCALATION_ACK,
  ESCALATION_DEDUP_REPLY,
  ESCALATION_NO_DEVICE_REPLY,
  startEscalation,
} from './escalation.js';
import { prepareFastTurn } from './images.js';
import { rocketChatPersona } from './persona.js';

/** What the turn needs of the connection it arrived on. */
interface TurnBot {
  botName: string;
  serverUrl: string;
  authToken: string;
  botUserId: string;
}

/** The messages one window collected, in the terms this transport needs them in. */
interface RocketChatTurnSubject {
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

interface RocketChatTurnArgs {
  bot: TurnBot;
  route: Route;
  subject: RocketChatTurnSubject;
  connectionId: string;
  shape: RoomShape;
  webBaseUrl: string | undefined;
  /** Why the window stopped collecting — a turn cut before quiet is told so in its persona (ISS-1086). */
  cut: WindowCut;
  /**
   * Make this turn's right to answer durable before a dispatch somebody else finishes.
   */
  beforeDivert?: () => Promise<boolean>;
  /**
   * How the conversation store addresses this turn's room, for the diversion that answers later.
   */
  window: {
    venue: ConversationVenue;
    conversationId: string;
    windowId: string;
    deliveryKey: string;
  };
}

/** Everything the neutral turn takes bar what the window and its venue settle. */
type RocketChatTurn = WindowTurnInputs;

interface Seed {
  persona: string;
  conversationContext: string | null;
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

  const readSeed = async (): Promise<Seed> => {
    if (seed) return seed;
    const conversationContext = await buildConversationContext(restAuth, {
      rid: subject.rid,
      tmid: subject.tmid,
      excludeMessageIds: subject.messageIds,
      triggerText: subject.text,
    });
    seed = {
      conversationContext,
      persona: rocketChatPersona(route.projectName, subject.username, {
        projectSlug: route.projectSlug,
        webBaseUrl: args.webBaseUrl,
        botName: bot.botName,
        cut: args.cut.reason,
      }),
    };
    return seed;
  };

  return {
    door: 'chat-sync',
    handleName: bot.botName,
    log: {
      connectionId: args.connectionId,
      rid: subject.rid,
      msgIds: subject.messageIds,
      projectId: route.projectId,
    },

    prepare: async ({
      setPhase,
      credential,
      speakerUserId,
      conversationId,
      handleUserId,
    }): Promise<TurnInputs> => {
      const s = await readSeed();
      setPhase('images');
      const fast = await prepareFastTurn({
        route,
        credential: await credential(),
        turn: { conversationId, speakerUserId, handleUserId },
        restAuth,
        rid: subject.rid,
        ...(subject.tmid ? { tmid: subject.tmid } : {}),
        images: subject.images,
      });
      return {
        tools: fast.tools,
        images: fast.images,
        resolveImage: fast.resolveImage,
        persona: s.persona,
        conversationContext: s.conversationContext,
      };
    },

    divertAfterTurn: (result, phase) => divertToEscalation(args, result, phase),
  };
}

type Divert = NonNullable<RocketChatTurn['divertAfterTurn']>;

/** A turn whose model called the escalate tool is answered by the escalation's own reply. */
async function divertToEscalation(
  args: RocketChatTurnArgs,
  result: Parameters<Divert>[0],
  { setPhase, authority }: Parameters<Divert>[1],
): Promise<TurnReply | null> {
  const { bot, route, subject } = args;
  const escalateCall = result.toolCalls.find((t) => t.name === ESCALATE_TOOL_NAME);
  if (!escalateCall) return null;
  setPhase('escalate');
  if (args.beforeDivert && !(await args.beforeDivert()))
    return { send: false, reason: 'superseded-before-escalation' };
  const started = await startEscalation({
    projectId: route.projectId,
    project: { id: route.projectId, slug: route.projectSlug },
    connectionId: args.connectionId,
    rid: subject.rid,
    tmid: subject.tmid,
    botName: bot.botName,
    question: escalationQuestion(escalateCall.arguments, subject.text),
    askedByUsername: subject.username,
    shape: args.shape,
    asker: authority,
  });
  const text = started.started
    ? ESCALATION_ACK(bot.botName)
    : started.reason === 'deduped'
      ? ESCALATION_DEDUP_REPLY(bot.botName)
      : started.reason === 'no-device'
        ? ESCALATION_NO_DEVICE_REPLY(bot.botName)
        : started.reason === 'runner-outdated' || started.reason === 'authority-refused'
          ? agentRefusalText(started)
          : null;
  return text === null
    ? { send: false, reason: 'escalation-dispatch-failed' }
    : { send: true, message: codeAuthored(text), screenReplaced: true };
}

function escalationQuestion(rawArguments: string, fallback: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as { question?: unknown };
    if (typeof parsed.question === 'string' && parsed.question.trim())
      return parsed.question.trim();
  } catch {}
  return fallback;
}
