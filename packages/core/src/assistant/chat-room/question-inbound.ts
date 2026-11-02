// A reply in a question's thread, read by the room's agent (ISS-857). A registered thread is
// consumed here and never falls through to the conversation handler, so every reply is either read
// by the agent, which answers it in its own words — recording the answer it gives, or asking back —
// or met with a last resort where no agent can speak: the speaker is linked to nobody, or the
// agent's turn failed, which tells the thread core's one turn-failed line (ISS-875). A turn that
// wrote nothing, or whose answer the reply check held, is the agent's silence, and nothing goes out.

import { and, eq } from 'drizzle-orm';
import { claimLastResort, releaseLastResort, replyLanguageOf } from '../../conversations/index.js';
import { db } from '../../db/client.js';
import { agentQuestions } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import type {
  RocketChatDdpClient,
  RocketChatIncomingMessage,
} from '../../integrations/rocketchat/index.js';
import {
  FIXED_REPLY_CONSTANT,
  namespaceFromServerUrl,
  type ReplyTransport,
  sendFixedReply,
} from '../../integrations/rocketchat/index.js';
import { issueDisplayIds } from '../../issues/index.js';
import { logger } from '../../lib/logger.js';
import { resolveSpeaker } from '../identity/speaker-link.js';
import { rocketChatVenueId } from './port.js';
import { type AnswerTool, answerQuestionTool } from './question-answer-tool.js';
import { agentReadsReply, type Spoken } from './question-voice.js';

/** Was this round actually put to somebody, or is it a round nobody has been shown? */
async function roundWasDelivered(questionId: string, round: number): Promise<boolean> {
  const [row] = await db
    .select({ status: rocketchatQuestionDeliveries.status })
    .from(rocketchatQuestionDeliveries)
    .where(
      and(
        eq(rocketchatQuestionDeliveries.questionId, questionId),
        eq(rocketchatQuestionDeliveries.round, round),
      ),
    )
    .limit(1);
  return row?.status === 'delivered';
}

type Question = typeof agentQuestions.$inferSelect;

/** Why the round cannot be answered in this thread, or null where it can. */
async function closedReason(question: Question): Promise<string | null> {
  const current = question.steps[question.steps.length - 1];
  if (question.status !== 'open') return `it is ${question.status} and no longer waits on anyone`;
  if (!current) return 'it carries no round to answer';
  if (current.sensitive === true && !(await roundWasDelivered(question.id, current.round)))
    return 'its round is private and was never put to anybody here, so it is not answered in this thread';
  return null;
}

interface ReplyArgs {
  questionId: string;
  serverUrl: string;
  botName?: string | undefined;
  m: RocketChatIncomingMessage;
  transport: ReplyTransport;
}

async function post(
  transport: ReplyTransport,
  text: string,
  proof: Parameters<typeof sendFixedReply>[2],
): Promise<boolean> {
  try {
    await sendFixedReply(transport, text, proof);
    return true;
  } catch (err) {
    logger.error(
      { err, rid: transport.rid },
      'chat-room.question-inbound: posting the reply failed',
    );
    return false;
  }
}

/**
 * Tell the thread its reply could not be read, in core's one last-resort line for it, where it was
 * told none yet; a post that fails gives the claim back.
 */
async function tellTurnFailed(
  transport: ReplyTransport,
  namespace: string | null,
  m: RocketChatIncomingMessage,
): Promise<void> {
  if (!namespace) return;
  const place = {
    adapter: 'rocketchat',
    venue: rocketChatVenueId(namespace, m.rid, m.tmid ?? m.id),
  };
  const line = await claimLastResort(place, 'turn_failed');
  if (!line) return;
  if (!(await post(transport, line, FIXED_REPLY_CONSTANT))) await releaseLastResort(place);
}

/**
 * Hand the reply to the room's agent with the round it answers. Always consumes the message.
 */
export async function handleQuestionThreadReply(args: ReplyArgs): Promise<void> {
  const { m } = args;
  const at = { questionId: args.questionId, rid: m.rid, msgId: m.id };
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.questionId))
    .limit(1);
  const current = question?.steps[question.steps.length - 1];
  if (!question || !current) {
    // the thread registry cascades with its question, so a thread naming none is a defect, not a reply
    logger.error(
      at,
      'chat-room.question-inbound: a question thread names no question with a round',
    );
    return;
  }
  const namespace = namespaceFromServerUrl(args.serverUrl);
  const resolution = namespace
    ? await resolveSpeaker(
        { source: 'rocketchat', namespace, externalId: m.userId, label: m.username ?? null },
        question.projectId,
      )
    : null;
  // the last resort the room keeps: nobody can be answered as a speaker linked to no Forge account
  if (resolution && !resolution.linked) {
    await post(args.transport, resolution.refusal.message, FIXED_REPLY_CONSTANT);
    return;
  }
  const closed = resolution
    ? await closedReason(question)
    : `this chat server's address (${args.serverUrl}) cannot be read as an identity, so no answer can be recorded as anyone here`;
  const tool: AnswerTool | null =
    resolution?.linked && !closed
      ? answerQuestionTool({
          questionId: question.id,
          round: current.round,
          message: { id: m.id, text: m.text },
          userId: resolution.userId,
        })
      : null;
  const issueKey = question.issueId
    ? ((await issueDisplayIds([question.issueId])).get(question.issueId) ?? null)
    : null;
  const language = replyLanguageOf(m.text);
  let spoken: Spoken;
  try {
    spoken = await agentReadsReply({
      projectId: question.projectId,
      botName: args.botName,
      round: {
        issueKey,
        step: current,
        parkDeadlineAt: question.parkDeadlineAt ?? null,
        askedBy: question.origin?.kind === 'conversation' ? question.origin.askedByLabel : null,
      },
      reply: { id: m.id, text: m.text, author: m.username ?? null },
      userId: resolution?.linked ? resolution.userId : undefined,
      replyLanguage: language,
      tools: tool?.toolset ?? null,
      closed,
    });
  } catch (err) {
    logger.error({ ...at, err }, 'chat-room.question-inbound: the reading turn threw');
    spoken = { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  if (spoken.kind !== 'spoken') {
    logger.warn(
      {
        ...at,
        kind: spoken.kind,
        reason: 'reason' in spoken ? spoken.reason : null,
        recorded: tool?.recorded() ?? false,
      },
      spoken.kind === 'error'
        ? 'chat-room.question-inbound: the room agent could not speak; core tells the thread once'
        : 'chat-room.question-inbound: the room agent said nothing; nothing goes out',
    );
  }
  if (spoken.kind === 'spoken') await post(args.transport, spoken.message.text, spoken.message);
  else if (spoken.kind === 'error') await tellTurnFailed(args.transport, namespace, m);
}

/** What the connection hands over with a thread reply: the socket it arrived on. */
interface QuestionReplySocket {
  serverUrl: string;
  authToken: string;
  botName?: string | undefined;
  client?: RocketChatDdpClient | undefined;
}

/**
 * The connection manager's half: build the transport and hand the reply over; the message is
 * consumed either way.
 */
export function consumeQuestionThreadReply(args: {
  questionId: string;
  connectionId: string;
  ac: QuestionReplySocket;
  m: RocketChatIncomingMessage;
}): void {
  const { ac, m } = args;
  const at = { connectionId: args.connectionId, rid: m.rid, questionId: args.questionId };
  const client = ac.client;
  if (!client) {
    logger.error(
      at,
      'rocketchat: a question thread reply arrived with no live socket to answer on',
    );
    return;
  }
  void handleQuestionThreadReply({
    questionId: args.questionId,
    serverUrl: ac.serverUrl,
    botName: ac.botName,
    m,
    transport: { kind: 'ddp', client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
  }).catch((err) =>
    logger.error({ ...at, err }, 'rocketchat: answering a question thread reply failed'),
  );
}
