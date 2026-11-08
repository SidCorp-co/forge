// The body an answer to a question is: read by every door that takes one, REST's answer route and the
// MCP door's `forge_questions answer` and `forge_requirements answer`, so a wrong answer is refused
// alike at each.

import { z } from 'zod';
import type { GivenAnswer } from './answer.js';

const answerFields = z.object({
  optionId: z.string({ error: 'optionId must be a string' }).optional(),
  text: z.string({ error: 'text must be a string' }).optional(),
  round: z
    .number({ error: 'round is required, as an integer' })
    .int({ error: 'round is required, as an integer' }),
  note: z
    .string({ error: 'note must be a string' })
    .max(1000, { error: 'note is at most 1000 characters' })
    .optional(),
  stillWaits: z
    .object(
      {
        reason: z
          .string({ error: 'stillWaits.reason must be a string' })
          .max(1000, { error: 'stillWaits.reason is at most 1000 characters' }),
        blockedBy: z
          .string({ error: 'stillWaits.blockedBy must be an issue key or id' })
          .max(200)
          .optional(),
      },
      {
        error:
          'stillWaits is { reason, blockedBy? }: what the issue still waits on after this answer',
      },
    )
    .strict()
    .optional(),
});

export const ANSWER_SHAPE =
  "{ round, optionId | text, note?, stillWaits? }: round is the round being answered, as an integer, and the answer is optionId (one of the question's options), text (a free answer), or both where the option chosen takes text (`takesText`)";

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const isBody = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// the one-answer rule reads the body even where a field of it failed, so one 400 names every fault
export const answerBody = answerFields
  .strict()
  .refine((b) => filled(b.optionId) || filled(b.text), {
    path: ['optionId'],
    message: 'the answer is required: send optionId or text',
    when: (p) => isBody(p.value),
  });

export type AnswerBody = z.infer<typeof answerBody>;

/** The answer a valid body gives, with what it carries beside it, as `answerAs` takes them. */
export function givenAnswerOf(body: AnswerBody): {
  answer: GivenAnswer;
  round: number;
  note?: string;
  stillWaits?: { reason: string; blockedBy?: string | undefined };
} {
  return {
    // an option and its words travel together; whether the option takes words is the question's to say (answer.ts)
    answer: filled(body.optionId)
      ? {
          kind: 'option',
          optionId: body.optionId as string,
          ...(filled(body.text) ? { text: body.text as string } : {}),
        }
      : { kind: 'text', text: body.text as string },
    round: body.round,
    ...(body.note === undefined ? {} : { note: body.note }),
    ...(body.stillWaits === undefined ? {} : { stillWaits: body.stillWaits }),
  };
}
