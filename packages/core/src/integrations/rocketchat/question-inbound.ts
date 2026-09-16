// A reply in a question's thread, answered or refused — and never handed on.
//
// Every path here returns having posted something into the thread, because a
// registered thread is consumed by this handler and never falls through to the
// conversation handler. Letting a refusal fall through turns "option 2 is
// admins only" into an LLM turn about the weather.

import { eq } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker, unlinkedMessage } from '../../assistant/identity/speaker-link.js';
import { db } from '../../db/client.js';
import { agentQuestions, isChoiceStep } from '../../db/schema-questions.js';
import { logger } from '../../logger.js';
import { problemsOf } from '../../messaging/contract.js';
import { screenAtDoor } from '../../messaging/screen.js';
import { answerAs } from '../../questions/read.js';
import { QuestionRefused } from '../../questions/write.js';
import type { RocketChatDdpClient, RocketChatIncomingMessage } from './ddp-client.js';
import { FIXED_REPLY_CONSTANT, type ReplyTransport, sendFixedReply } from './outbound.js';
import {
  AMBIGUOUS_ROUND_REPLY,
  ANSWER_FAILED,
  ANSWER_RECORDED,
  agentAuthoredSegments,
  optionToken,
  parseChoice,
  renderOptionsAgain,
  STALE_ROUND_REPLY,
  UNKNOWN_OPTION_REPLY,
} from './question-render.js';

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

/**
 * Answer, or refuse by name. Always consumes the message.
 */
export async function handleQuestionThreadReply(args: {
  questionId: string;
  serverUrl: string;
  m: RocketChatIncomingMessage;
  transport: ReplyTransport;
}): Promise<void> {
  const { m, transport } = args;
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, args.questionId))
    .limit(1);
  if (!question) {
    await say(transport, ANSWER_FAILED('that question is no longer on the record.'));
    return;
  }
  const rounds = question.steps.length;
  const current = question.steps[rounds - 1];
  if (!current) {
    await say(transport, ANSWER_FAILED('that question carries no round to answer.'));
    return;
  }

  const choiceRound = isChoiceStep(current);
  let chosenOptionId: string | null = null;
  let token = '';
  if (!choiceRound) {
    if (!m.text.trim()) {
      await say(
        transport,
        ANSWER_FAILED('that reply carries no text, and this round asks for some.'),
      );
      return;
    }
  } else {
    const choice = parseChoice(m.text, rounds);
    if (!choice.ok) {
      if (choice.reason === 'ambiguous') {
        await say(transport, AMBIGUOUS_ROUND_REPLY);
        return;
      }
      const verdict = screenAtDoor('question-delivery', agentAuthoredSegments(current));
      await (verdict.ok
        ? sendFixedReply(transport, renderOptionsAgain(current, rounds), {
            ok: true,
            problems: problemsOf(verdict),
          }).catch((err) =>
            logger.error(
              { err, rid: transport.rid },
              'rocketchat.question-inbound: re-post failed',
            ),
          )
        : say(
            transport,
            ANSWER_FAILED('that reply named no option, and the options cannot be shown here.'),
          ));
      return;
    }

    if (choice.round !== current.round) {
      await say(transport, STALE_ROUND_REPLY(choice.round, current.round));
      return;
    }
    const option = current.options[choice.index];
    token = optionToken(current.round, choice.index, rounds);
    if (!option) {
      await say(transport, UNKNOWN_OPTION_REPLY(token));
      return;
    }
    chosenOptionId = option.id;
  }

  const namespace = namespaceFromServerUrl(args.serverUrl);
  if (!namespace) {
    await say(
      transport,
      ANSWER_FAILED(
        `this Rocket.Chat server's address (${args.serverUrl}) cannot be read as a channel identity, so nothing can be answered as you here.`,
      ),
    );
    return;
  }
  const ref = {
    source: 'rocketchat',
    namespace,
    externalId: m.userId,
    label: m.username ?? null,
  };
  const resolution = await resolveSpeaker(ref);
  if (!resolution.linked) {
    await say(
      transport,
      resolution.refusal.code === 'SPEAKER_UNLINKED'
        ? unlinkedMessage(ref)
        : resolution.refusal.message,
    );
    return;
  }

  try {
    await answerAs({
      questionId: args.questionId,
      answer: chosenOptionId
        ? { kind: 'option', optionId: chosenOptionId }
        : { kind: 'text', text: m.text },
      round: current.round,
      userId: resolution.userId,
    });
  } catch (err) {
    if (err instanceof QuestionRefused) {
      await say(transport, ANSWER_FAILED(err.message));
      return;
    }
    logger.error(
      { err, questionId: args.questionId, rid: m.rid },
      'rocketchat.question-inbound: recording the answer failed',
    );
    await say(transport, ANSWER_FAILED('it could not be written. Nothing has changed.'));
    return;
  }
  await say(transport, ANSWER_RECORDED(token, m.username ?? '', resolution.userId));
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
