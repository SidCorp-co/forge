// A reply in a question's thread, answered or refused — and never handed on.
//
// Every path here returns having posted something into the thread, because a
// registered thread is consumed by this handler and never falls through to the
// conversation handler. Letting a refusal fall through turns "option 2 is
// admins only" into an LLM turn about the weather.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentQuestions, isChoiceStep } from '../../db/schema-questions.js';
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
import { logger } from '../../lib/logger.js';
import { isRefusal } from '../../lib/refusal.js';
import { screenForDoor } from '../../messaging/proven.js';
import { answerAs } from '../../questions/index.js';
import { resolveSpeaker } from '../identity/speaker-link.js';
import {
  AMBIGUOUS_ROUND_REPLY,
  ANSWER_FAILED,
  ANSWER_RECORDED,
  optionToken,
  parseChoice,
  renderOptionsAgain,
  STALE_ROUND_REPLY,
  UNKNOWN_OPTION_REPLY,
} from './question-render.js';

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

async function say(transport: ReplyTransport, text: string): Promise<void> {
  try {
    await sendFixedReply(transport, text, FIXED_REPLY_CONSTANT);
  } catch (err) {
    logger.error(
      { err, rid: transport.rid },
      'rocketchat.question-inbound: posting the outcome failed',
    );
  }
}

type Question = typeof agentQuestions.$inferSelect;
type Round = Question['steps'][number];
type Chosen = { optionId: string | null; token: string };

/** The round this reply can answer, or the refusal to post. */
async function openRound(questionId: string) {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!question) return ANSWER_FAILED('that question is no longer on the record.');
  const current = question.steps[question.steps.length - 1];
  if (!current) return ANSWER_FAILED('that question carries no round to answer.');
  if (current.sensitive === true && !(await roundWasDelivered(questionId, current.round)))
    return ANSWER_FAILED(
      'that question is waiting on something private, and it has not been put to anybody here — it cannot be shown or answered in this thread.',
    );
  return { question, current };
}

/** What the reply chose, the refusal to post, or null once the options are posted again. */
async function readChoice(
  text: string,
  current: Round,
  rounds: number,
  transport: ReplyTransport,
): Promise<Chosen | string | null> {
  if (!isChoiceStep(current))
    return text.trim()
      ? { optionId: null, token: '' }
      : ANSWER_FAILED('that reply carries no text, and this round asks for some.');
  const choice = parseChoice(text, rounds);
  if (!choice.ok) {
    if (choice.reason === 'ambiguous') return AMBIGUOUS_ROUND_REPLY;
    const screening = screenForDoor('question-delivery', renderOptionsAgain(current, rounds));
    if (!screening.ok)
      return ANSWER_FAILED('that reply named no option, and the options cannot be shown here.');
    await sendFixedReply(transport, screening.proven.text, screening.proven).catch((err) =>
      logger.error({ err, rid: transport.rid }, 'rocketchat.question-inbound: re-post failed'),
    );
    return null;
  }
  if (choice.round !== current.round) return STALE_ROUND_REPLY(choice.round, current.round);
  const option = current.options[choice.index];
  const token = optionToken(current.round, choice.index, rounds);
  return option ? { optionId: option.id, token } : UNKNOWN_OPTION_REPLY(token);
}

/** The reply to post in the thread, or null where the options were posted again. */
async function replyTo(args: {
  questionId: string;
  serverUrl: string;
  m: RocketChatIncomingMessage;
  transport: ReplyTransport;
}): Promise<string | null> {
  const { m } = args;
  const open = await openRound(args.questionId);
  if (typeof open === 'string') return open;
  const { question, current } = open;
  const chosen = await readChoice(m.text, current, question.steps.length, args.transport);
  if (chosen === null || typeof chosen === 'string') return chosen;
  const namespace = namespaceFromServerUrl(args.serverUrl);
  if (!namespace)
    return ANSWER_FAILED(
      `this Rocket.Chat server's address (${args.serverUrl}) cannot be read as a channel identity, so nothing can be answered as you here.`,
    );
  const resolution = await resolveSpeaker(
    { source: 'rocketchat', namespace, externalId: m.userId, label: m.username ?? null },
    question.projectId,
  );
  if (!resolution.linked) return resolution.refusal.message;
  try {
    // a room reply comes through the assistant's chat door, so a channel gate it decides records via assistant, never web
    await answerAs({
      questionId: args.questionId,
      answer: chosen.optionId
        ? { kind: 'option', optionId: chosen.optionId }
        : { kind: 'text', text: m.text },
      round: current.round,
      userId: resolution.userId,
      via: 'assistant',
    });
  } catch (err) {
    if (isRefusal(err)) return ANSWER_FAILED(err.refusals.map((r) => r.detail).join('; '));
    logger.error(
      { err, questionId: args.questionId, rid: m.rid },
      'rocketchat.question-inbound: recording the answer failed',
    );
    return ANSWER_FAILED('it could not be written. Nothing has changed.');
  }
  return ANSWER_RECORDED(chosen.token, m.username ?? '', resolution.userId);
}

/**
 * Answer, or refuse by name. Always consumes the message.
 */
async function handleQuestionThreadReply(args: Parameters<typeof replyTo>[0]): Promise<void> {
  const text = await replyTo(args);
  if (text !== null) await say(args.transport, text);
}

/**
 * The connection manager's half: build the transport, hand the reply over, and
 * say nothing back — the message is consumed either way.
 */
interface QuestionReplySocket {
  serverUrl: string;
  authToken: string;
  client?: RocketChatDdpClient | undefined;
}

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
    m,
    transport: { kind: 'ddp', client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
  }).catch((err) =>
    logger.error({ ...at, err }, 'rocketchat: answering a question thread reply failed'),
  );
}
