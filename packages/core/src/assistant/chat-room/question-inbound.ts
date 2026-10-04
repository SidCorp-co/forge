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
import { isRefusal } from '../../lib/refusal.js';
import { screenForDoor } from '../../messaging/proven.js';
import { logger } from '../../observability/logger.js';
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

/** The round this reply can answer, or null once the refusal is posted. */
async function openRound(questionId: string, transport: ReplyTransport) {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!question) {
    await say(transport, ANSWER_FAILED('that question is no longer on the record.'));
    return null;
  }
  const current = question.steps[question.steps.length - 1];
  if (!current) {
    await say(transport, ANSWER_FAILED('that question carries no round to answer.'));
    return null;
  }
  if (current.sensitive === true && !(await roundWasDelivered(questionId, current.round))) {
    await say(
      transport,
      ANSWER_FAILED(
        'that question is waiting on something private, and it has not been put to anybody here — it cannot be shown or answered in this thread.',
      ),
    );
    return null;
  }
  return { question, current };
}

/** What the reply chose, or null once the refusal (or the options again) is posted. */
async function readChoice(
  text: string,
  current: Round,
  rounds: number,
  transport: ReplyTransport,
): Promise<Chosen | null> {
  if (!isChoiceStep(current)) {
    if (text.trim()) return { optionId: null, token: '' };
    await say(
      transport,
      ANSWER_FAILED('that reply carries no text, and this round asks for some.'),
    );
    return null;
  }
  const choice = parseChoice(text, rounds);
  if (!choice.ok) {
    if (choice.reason === 'ambiguous') {
      await say(transport, AMBIGUOUS_ROUND_REPLY);
      return null;
    }
    const screening = screenForDoor('question-delivery', renderOptionsAgain(current, rounds));
    await (screening.ok
      ? sendFixedReply(transport, screening.proven.text, screening.proven).catch((err) =>
          logger.error({ err, rid: transport.rid }, 'rocketchat.question-inbound: re-post failed'),
        )
      : say(
          transport,
          ANSWER_FAILED('that reply named no option, and the options cannot be shown here.'),
        ));
    return null;
  }
  if (choice.round !== current.round) {
    await say(transport, STALE_ROUND_REPLY(choice.round, current.round));
    return null;
  }
  const option = current.options[choice.index];
  const token = optionToken(current.round, choice.index, rounds);
  if (!option) {
    await say(transport, UNKNOWN_OPTION_REPLY(token));
    return null;
  }
  return { optionId: option.id, token };
}

/** The Forge user this Rocket.Chat speaker is linked to, or null once the refusal is posted. */
async function answererOf(
  serverUrl: string,
  m: RocketChatIncomingMessage,
  projectId: string,
  transport: ReplyTransport,
): Promise<string | null> {
  const namespace = namespaceFromServerUrl(serverUrl);
  if (!namespace) {
    await say(
      transport,
      ANSWER_FAILED(
        `this Rocket.Chat server's address (${serverUrl}) cannot be read as a channel identity, so nothing can be answered as you here.`,
      ),
    );
    return null;
  }
  const resolution = await resolveSpeaker(
    { source: 'rocketchat', namespace, externalId: m.userId, label: m.username ?? null },
    projectId,
  );
  if (resolution.linked) return resolution.userId;
  await say(transport, resolution.refusal.message);
  return null;
}

/**
 * Answer, or refuse by name. Always consumes the message.
 */
async function handleQuestionThreadReply(args: {
  questionId: string;
  serverUrl: string;
  m: RocketChatIncomingMessage;
  transport: ReplyTransport;
}): Promise<void> {
  const { m, transport } = args;
  const open = await openRound(args.questionId, transport);
  if (!open) return;
  const { question, current } = open;
  const chosen = await readChoice(m.text, current, question.steps.length, transport);
  if (!chosen) return;
  const userId = await answererOf(args.serverUrl, m, question.projectId, transport);
  if (!userId) return;

  try {
    // cm:why a room reply comes through the assistant's chat door, so a channel gate it decides records via assistant, never web
    await answerAs({
      questionId: args.questionId,
      answer: chosen.optionId
        ? { kind: 'option', optionId: chosen.optionId }
        : { kind: 'text', text: m.text },
      round: current.round,
      userId,
      via: 'assistant',
    });
  } catch (err) {
    if (isRefusal(err)) {
      await say(transport, ANSWER_FAILED(err.refusals.map((r) => r.detail).join('; ')));
      return;
    }
    logger.error(
      { err, questionId: args.questionId, rid: m.rid },
      'rocketchat.question-inbound: recording the answer failed',
    );
    await say(transport, ANSWER_FAILED('it could not be written. Nothing has changed.'));
    return;
  }
  await say(transport, ANSWER_RECORDED(chosen.token, m.username ?? '', userId));
}

/**
 * The connection manager's half: build the transport, hand the reply over, and
 * say nothing back — the message is consumed either way.
 */
export interface QuestionReplySocket {
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
