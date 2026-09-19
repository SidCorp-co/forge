// A reply in a question's thread, answered or refused — and never handed on.
//
// Every path here returns having posted something into the thread, because a
// registered thread is consumed by this handler and never falls through to the
// conversation handler. Letting a refusal fall through turns "option 2 is
// admins only" into an LLM turn about the weather.

import { and, eq } from 'drizzle-orm';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { resolveSpeaker } from '../../assistant/identity/speaker-link.js';
import { db } from '../../db/client.js';
import { agentQuestions, isChoiceStep } from '../../db/schema-questions.js';
import { rocketchatQuestionDeliveries } from '../../db/schema-rocketchat.js';
import { logger } from '../../logger.js';
import { screenForDoor } from '../../messaging/proven.js';
import { answerAs } from '../../questions/read.js';
import { QuestionRefused } from '../../questions/write.js';
import type { RocketChatDdpClient, RocketChatIncomingMessage } from './ddp-client.js';
import { FIXED_REPLY_CONSTANT, type ReplyTransport, sendFixedReply } from './outbound.js';
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
// cm:guard reads the DELIVERY row and not the question, because a round exists on `agent_questions` from the moment it is asked and is delivered — or refused — separately. A reply cannot answer a round nobody was shown, and the material of one must not be rendered on the strength of a reply to a different round.
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

/**
 * Answer, or refuse by name. Always consumes the message.
 */
// cm:guard EVERY return is a consumed message, refusals included — the caller must not fall through to the conversation handler on any of them, which is why this returns void rather than a handled/unhandled flag somebody could forget to read (ISS-978 criterion 20).
// cm:guard the answer goes through `answerAs` and never `answerQuestion`: the authority gate lives in `answerAs`, and a second caller that skips it is a lock drawn on the screen and nowhere else (ISS-978 criterion 11).
// cm:guard nothing here writes an issue comment. `answer-resume.ts` reads a comment as a prose resume and would act on the same decision a second time, so a structured answer that also commented would revive the box twice (ISS-978 criterion 29).
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

  // cm:guard a PRIVATE round that was never delivered is refused here without one word of its material reaching this thread, and refusing the delivery is not enough on its own: the round is still this question's current one, so a reply arriving in the thread an EARLIER public round opened reaches the re-post below, which renders the current round's options into whichever room the reply came from. That is the disclosure the private destination exists to prevent, performed by the answer path instead of the delivery path (ISS-1091 criterion 5).
  // cm:guard scoped to a private round, deliberately, so an ordinary round keeps today's behaviour exactly: the delivered mark is written just after the post returns, and gating every round on it would refuse a reply that landed in that window.
  if (current.sensitive === true && !(await roundWasDelivered(args.questionId, current.round))) {
    await say(
      transport,
      ANSWER_FAILED(
        'that question is waiting on something private, and it has not been put to anybody here — it cannot be shown or answered in this thread.',
      ),
    );
    return;
  }

  // cm:guard a free-text round is answered by the WHOLE message and never goes through the token parser: prose is what that round asked for, and reading it for an option number re-posts a list the person was never shown (ISS-996).
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
      // cm:guard the options are re-posted rather than inferred from, and never defaulted to the recommended one — a reply nobody can read is a person who has not chosen yet, and choosing for them is the failure a locked option exists to prevent (ISS-978 criterion 18).
      const screening = screenForDoor('question-delivery', renderOptionsAgain(current, rounds));
      await (screening.ok
        ? sendFixedReply(transport, screening.proven.text, screening.proven).catch((err) =>
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

    // cm:guard the round is taken from the REPLY and compared here, so a token naming a superseded round is refused as stale before any option is looked up — resolving it against the latest step would hand somebody an action they never saw offered (ISS-978 criterion 16).
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
  const resolution = await resolveSpeaker(ref, question.projectId);
  // cm:guard an unmapped speaker is refused with ISS-977's own text and not a local rewording: the way out — a confirm link where the project is known, the endpoint where it is not, and that the person links themselves either way — is that module's contract, and a second copy of it drifts silently (ISS-978 criterion 12). The projectId is passed IN rather than the message rebuilt out here, so the link travels on every path that knows a project and this file holds no copy of the text.
  if (!resolution.linked) {
    await say(transport, resolution.refusal.message);
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
// cm:guard lives here rather than inside `connection-manager.route()` because that file is over its size budget and this is the whole of what `route` would otherwise hold: the caller returns immediately after calling it, and a `return` it forgets is a refusal delivered as an LLM turn (ISS-978 criterion 20).
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
