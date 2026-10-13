import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { conversationAdapters } from '../db/schema-conversations.js';
import {
  agentQuestions,
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
  questionStatuses,
} from '../db/schema-questions.js';

const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
  authority: z.enum(optionAuthorities),
  bindsTo: z.enum(optionBindings),
  executedBy: z.enum(optionExecutors),
  fingerprint: z.string().optional(),
});

const stepCommon = {
  round: z.number(),
  prompt: z.string(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
  answeredBy: z.string().optional(),
  sensitive: z.boolean().optional(),
};

/** One round of a question: options to choose from, or a statement of what free text would settle it. */
export const questionStepSchema = z.union([
  z.object({
    ...stepCommon,
    answerShape: z.literal('choice'),
    options: z.array(optionSchema),
    recommendedOptionId: z.string(),
    chosenOptionId: z.string().optional(),
  }),
  z.object({
    ...stepCommon,
    answerShape: z.literal('free_text'),
    needed: z.string(),
    answerText: z.string().optional(),
  }),
]);

const originSchema = z.union([
  z.object({
    kind: z.literal('conversation'),
    adapter: z.enum(conversationAdapters),
    venueId: z.string(),
    conversationId: z.string(),
    windowId: z.string(),
    anchorId: z.string().nullable(),
    askedByUserId: z.string().nullable(),
    askedByLabel: z.string().nullable(),
    askedByKey: z.string().nullable(),
  }),
  z.object({ kind: z.literal('unresolved'), reason: z.string() }),
]);

const answerShapeSchema = z.enum(['choice', 'free_text']);

/** The row as stored, with its rounds and origin in the shape they are written. */
const questionRowSchema = tableRow(agentQuestions).extend({
  steps: z.array(questionStepSchema),
  origin: originSchema.nullable(),
});

/** What a write answers: the row, and what its current round asks. */
export const questionViewSchema = questionRowSchema.extend({
  answerShape: answerShapeSchema,
  recommendedOptionId: z.string(),
});

const currentRound = {
  answerShape: answerShapeSchema,
  options: z.array(optionSchema.extend({ locked: z.boolean() })),
  recommendedOptionId: z.string(),
  needed: z.string(),
  locked: z.boolean(),
  prompt: z.string(),
  round: z.number(),
  askedAt: z.string(),
};

/** A question as its reader may act on it: each option says whether the reader may choose it. */
export const seenQuestionSchema = questionRowSchema.extend(currentRound);

export const issueQuestionsSchema = z.object({ questions: z.array(seenQuestionSchema) });

export const projectQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      issueId: z.string().nullable(),
      agentSessionId: z.string().nullable(),
      status: z.enum(questionStatuses),
      blockerKind: z.enum(questionBlockerKinds),
      maxRounds: z.number(),
      assumed: z.record(z.string(), z.unknown()).nullable(),
      voidReason: z.string().nullable(),
      claimsHeld: z.number(),
      workspacesPinned: z.number(),
      dependents: z.number(),
      parkDeadlineAt: z.date().nullable(),
      endedBy: z.string().nullable(),
      endedReason: z.string().nullable(),
      createdAt: z.date(),
      updatedAt: z.date(),
      rounds: z.number(),
      currentStep: questionStepSchema.nullable(),
      ...currentRound,
    }),
  ),
  total: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const questionVoidedSchema = z.object({ ok: z.literal(true) });

/** Query as it arrives: every value is text, and the route refuses a bad one by name. */
export const questionListQuerySchema = z.object({
  issueId: z
    .string()
    .describe('The issue to list the questions of; a uuid. Send this or projectId.')
    .optional(),
  projectId: z
    .string()
    .describe('The project to list the questions of, newest first; a uuid. Send this or issueId.')
    .optional(),
  issue: z
    .string()
    .describe('Only `none`: with projectId, the questions that name no issue.')
    .optional(),
  status: z
    .string()
    .describe(`With projectId, one of ${questionStatuses.join(', ')}.`)
    .optional(),
  limit: z.string().describe('With projectId, the page size, 1 to 200; 50 when absent.').optional(),
  cursor: z
    .string()
    .describe('With projectId, the `nextCursor` of the previous page, sent back as it arrived.')
    .optional(),
});

export const questionIdParamSchema = z.object({ id: z.uuid() });

export const answerQuestionBodySchema = z.object({
  optionId: z
    .string()
    .describe('The option chosen, for a round that offers options.')
    .optional()
    .catch(undefined),
  text: z
    .string()
    .describe('The reply, for a round that asks for text.')
    .optional()
    .catch(undefined),
  round: z
    .number()
    .describe('The round the answerer was shown, an integer; required.')
    .optional()
    .catch(undefined),
});

export const voidQuestionBodySchema = z.object({
  reason: z
    .string()
    .describe('Why the question is withdrawn; required.')
    .optional()
    .catch(undefined),
});

const NEEDS_SESSION = 'a personal access token answered a question that a person owes';

export const listQuestions = describeOperation({
  summary: "List a project's questions, or one issue's",
  description:
    "Send `projectId` for a page of the project's questions, or `issueId` for every question of one issue, never both.",
  responses: {
    200: json(
      z.union([projectQuestionsSchema, issueQuestionsSchema]),
      "A page of questions, or an issue's questions",
    ),
    400: fail(
      'BAD_REQUEST',
      'neither or both of issueId and projectId, a value that is not a uuid, an unknown `issue` or `status`, or a bad `limit` or `cursor`',
    ),
    404: fail('NOT_FOUND', 'the project or issue does not exist, or the caller cannot reach it'),
  },
});

export const askQuestionRoute = describeOperation({
  summary: 'Ask a question about an issue, with the options that would settle it',
  responses: {
    201: json(questionViewSchema, 'The question as written'),
    400: fail({
      BAD_REQUEST: 'the body is not a valid question',
      QUESTION_OPTIONS_REQUIRED: 'no options were given',
      QUESTION_OPTION_IDS_DUPLICATE: 'two options carry the same id',
      QUESTION_RECOMMENDED_UNKNOWN: 'the recommended option is not one of the options',
      QUESTION_MESSAGE_REFUSED: 'the prompt or an option was refused by the message screen',
      QUESTION_ISSUE_ELSEWHERE: 'the issue does not exist or belongs to another project',
    }),
    403: fail({
      QUESTION_REFUSED:
        "the caller is a viewer on the issue's project, or an option bound to one call carries no fingerprint",
    }),
    404: fail('NOT_FOUND', 'the issue does not exist, or the caller cannot reach it'),
    409: fail('QUESTION_ISSUE_TERMINAL', 'the issue is finished, so no answer could reach it'),
  },
});

export const readQuestion = describeOperation({
  summary: 'Read one question as the caller may act on it',
  responses: {
    200: json(seenQuestionSchema),
    400: fail('BAD_REQUEST', 'the id is not a uuid'),
    404: fail('NOT_FOUND', 'the question does not exist, or the caller cannot reach it'),
  },
});

export const answerQuestionRoute = describeOperation({
  summary: 'Answer the open round of a question with an option or with text',
  description:
    "Send `optionId` or `text`, never both, and the `round` you were shown. A personal access token may answer only a question blocked on another agent, with that agent's own token.",
  responses: {
    200: json(questionViewSchema, 'The question, answered'),
    400: fail({
      BAD_REQUEST:
        'the id is not a uuid, both or neither of optionId and text, or no integer round',
      QUESTION_OPTION_UNKNOWN: 'the option is not on this round',
      QUESTION_ANSWER_WRONG_SHAPE:
        'text for a round of options, an option for a round of text, or empty text',
    }),
    403: fail({
      QUESTION_NEEDS_SESSION: NEEDS_SESSION,
      QUESTION_NEEDS_AGENT_CREDENTIAL:
        "the question is blocked on another agent and the token is a person's, not the agent's own",
      QUESTION_AUTHORITY_REQUIRED:
        "the caller's role may not choose this option or reply in free text",
    }),
    404: fail({
      NOT_FOUND: 'the question does not exist, or the token cannot reach it',
      QUESTION_NOT_FOUND: 'the question does not exist, or the caller cannot reach it',
    }),
    409: fail({
      QUESTION_NOT_OPEN: 'the question is not open',
      QUESTION_EXPIRED: 'the park deadline has passed',
      QUESTION_ROUND_STALE: 'the answer names a round that has been superseded',
    }),
  },
});

export const voidQuestionRoute = describeOperation({
  summary: 'Withdraw an open question, with the reason',
  responses: {
    200: json(questionVoidedSchema),
    400: fail({
      BAD_REQUEST: 'the id is not a uuid',
      QUESTION_REASON_REQUIRED: 'no reason was given',
    }),
    403: fail('QUESTION_NEEDS_SESSION', 'a personal access token cannot void a question'),
    404: fail({
      NOT_FOUND: 'the question does not exist, or the caller cannot reach it',
      QUESTION_NOT_FOUND: 'the question was deleted while it was being voided',
    }),
    409: fail('QUESTION_NOT_OPEN', 'the question is already answered, void or expired'),
  },
});
