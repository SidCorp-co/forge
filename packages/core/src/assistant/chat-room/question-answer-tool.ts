// The one door through which a chat room's agent records an answer to a parked run's question
// (ISS-857). The person answers in plain words; the agent reads them and calls `answer_question`
// citing the message they answered in. Core checks the citation against what the chat server
// handed this turn — the reply in the question's own thread, from a person linked to a Forge
// account — and answers as that person through `answerAs`, whose checks (the round still open, an
// option only an admin may take) come back to the agent as the tool's answer, never as a post.
// For a round asked in words, what is recorded is the person's message as written, never the
// agent's reading of it.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentQuestions, isChoiceStep } from '../../db/schema-questions.js';
import { logger } from '../../lib/logger.js';
import { isRefusal } from '../../lib/refusal.js';
import { answerAs } from '../../questions/index.js';
import type { ChatToolset } from '../tools/mcp-adapter.js';

export const ANSWER_QUESTION_TOOL = 'answer_question';

/** What one reading turn may cite: the reply it was handed, and who the chat server says wrote it. */
export interface AnswerCitation {
  questionId: string;
  /** The round the turn was shown; an answer to a round the question has moved past is refused. */
  round: number;
  message: { id: string; text: string };
  /** The Forge user the reply's writer is linked to, who the answer is recorded as. */
  userId: string;
}

export interface AnswerTool {
  toolset: ChatToolset;
  /** Whether an answer was recorded by this turn. */
  recorded: () => boolean;
}

const said = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

interface Refused {
  refusal: { code: string; path: string; detail: string };
}

const no = (refusal: Refused['refusal']): Refused => ({ refusal });

const refused = (code: string, path: string, detail: string) =>
  said({ refused: [{ code, path, detail }] }, true);

function argsOf(argsJson: string): Record<string, unknown> | null {
  try {
    const v = argsJson.trim() ? (JSON.parse(argsJson) as unknown) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The answer the call names, or the refusal to hand back; nothing is written either way. */
async function answerNamed(
  c: AnswerCitation,
  args: Record<string, unknown>,
): Promise<{ answer: Parameters<typeof answerAs>[0]['answer']; label: string | null } | Refused> {
  const [question] = await db
    .select({ status: agentQuestions.status, steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, c.questionId))
    .limit(1);
  const current = question?.steps[question.steps.length - 1];
  if (question?.status !== 'open' || !current) {
    return no({
      code: 'QUESTION_NOT_OPEN',
      path: '',
      detail: `this question is ${question ? question.status : 'no longer on the record'}, so nothing can be answered on it. Nothing was recorded.`,
    });
  }
  if (current.round !== c.round) {
    return no({
      code: 'QUESTION_ROUND_MOVED',
      path: '/round',
      detail: `the question moved on to round ${current.round} after this reply was read; ask the person about the round as it stands. Nothing was recorded.`,
    });
  }
  if (!isChoiceStep(current)) {
    if (args.option !== undefined) {
      return no({
        code: 'QUESTION_TAKES_WORDS',
        path: '/option',
        detail:
          "this round asks for the answer in words and has no options: call with message alone, and the person's reply is recorded as they wrote it. Nothing was recorded.",
      });
    }
    if (!c.message.text.trim()) {
      return no({
        code: 'QUESTION_ANSWER_EMPTY',
        path: '/message',
        detail: 'the cited message carries no words to record. Nothing was recorded.',
      });
    }
    return { answer: { kind: 'text', text: c.message.text }, label: null };
  }
  const ids = current.options.map((o) => o.id).join(', ');
  const option = current.options.find((o) => o.id === args.option);
  if (!option) {
    return no({
      code:
        typeof args.option === 'string' ? 'QUESTION_OPTION_UNKNOWN' : 'QUESTION_OPTION_REQUIRED',
      path: '/option',
      detail: `${typeof args.option === 'string' ? `${args.option} is no option of this round; ` : 'this round is a choice: pass option, '}one of ${ids}. Nothing was recorded.`,
    });
  }
  return { answer: { kind: 'option', optionId: option.id }, label: option.label };
}

/**
 * The tool a reading turn is offered: one call records the answer the cited message gives.
 */
export function answerQuestionTool(c: AnswerCitation): AnswerTool {
  let recorded = false;
  const toolset: ChatToolset = {
    tools: [
      {
        type: 'function',
        function: {
          name: ANSWER_QUESTION_TOOL,
          description:
            "Record the person's answer to the question, once their reply clearly gives one. `message` is the id of the reply you were handed. For a choice, `option` is the id of the option their words pick; for a question asked in words, leave `option` out and their reply is recorded as written. Do not call it when the reply is unclear or does not answer: ask them back instead.",
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The id of the reply that answers.' },
              option: { type: 'string', description: 'The id of the chosen option.' },
            },
            required: ['message'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async (name, argsJson) => {
      if (name !== ANSWER_QUESTION_TOOL)
        return refused('TOOL_UNKNOWN', '', `${name} is not offered here`);
      const args = argsOf(argsJson);
      if (!args) return refused('ARGS_INVALID', '', 'the arguments were not a JSON object');
      if (recorded) {
        return refused('QUESTION_ALREADY_ANSWERED', '', 'this turn already recorded the answer.');
      }
      if (args.message !== c.message.id) {
        return refused(
          'QUESTION_MESSAGE_UNKNOWN',
          '/message',
          `${String(args.message)} is not the reply this turn was handed; cite ${c.message.id}, the message the person answered in. Nothing was recorded.`,
        );
      }
      const named = await answerNamed(c, args);
      if ('refusal' in named) return said({ refused: [named.refusal] }, true);
      try {
        // a room reply comes through the assistant's chat door, so a gate it decides records via assistant, never web
        await answerAs({
          questionId: c.questionId,
          answer: named.answer,
          round: c.round,
          userId: c.userId,
          via: 'assistant',
        });
      } catch (err) {
        if (isRefusal(err)) return said({ refused: err.refusals }, true);
        logger.error(
          { err, questionId: c.questionId, round: c.round },
          'chat-room.question: recording the answer failed',
        );
        return refused(
          'QUESTION_ANSWER_UNWRITTEN',
          '',
          'the answer could not be written. Nothing changed.',
        );
      }
      recorded = true;
      // the audit fact beside the answer the kernel recorded: which message, cited by the room's agent
      logger.info(
        { questionId: c.questionId, round: c.round, messageId: c.message.id, userId: c.userId },
        'chat-room.question: answer recorded on the message the room agent cited',
      );
      return said({
        recorded: true,
        round: c.round,
        ...(named.label ? { option: named.label } : { answer: c.message.text }),
        note: 'The run that asked is woken. Tell the person what was recorded, in your own words.',
      });
    },
    ranAs: () => c.userId,
  };
  return { toolset, recorded: () => recorded };
}
