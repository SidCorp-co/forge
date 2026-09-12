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
import { agentQuestions } from '../../db/schema-questions.js';
import { logger } from '../../logger.js';
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
import { screenOperatorMessage } from './reply-guard.js';

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

  const choice = parseChoice(m.text, rounds);
  if (!choice.ok) {
    if (choice.reason === 'ambiguous') {
      await say(transport, AMBIGUOUS_ROUND_REPLY);
      return;
    }
    // cm:guard the options are re-posted rather than inferred from, and never defaulted to the recommended one — a reply nobody can read is a person who has not chosen yet, and choosing for them is the failure a locked option exists to prevent (ISS-978 criterion 18).
    const verdict = screenOperatorMessage(agentAuthoredSegments(current));
    await (verdict.ok
      ? sendFixedReply(transport, renderOptionsAgain(current, rounds), {
          ok: true,
          problems: verdict.problems,
        }).catch((err) =>
          logger.error({ err, rid: transport.rid }, 'rocketchat.question-inbound: re-post failed'),
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
  const token = optionToken(current.round, choice.index, rounds);
  if (!option) {
    await say(transport, UNKNOWN_OPTION_REPLY(token));
    return;
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
  // cm:guard an unmapped speaker is refused with ISS-977's own text and not a local rewording: the way out — the two endpoints, and that the person links themselves — is that module's contract, and a second copy of it drifts silently (ISS-978 criterion 12).
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
      optionId: option.id,
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
