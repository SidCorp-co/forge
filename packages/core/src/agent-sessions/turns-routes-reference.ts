import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { agentSessionTurns } from '../db/schema.js';
import { sessionSchema } from './routes-reference.js';

export const turnIdParamSchema = z.object({
  id: z.uuid(),
  turnId: z.uuid(),
});

export const turnsQuerySchema = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const editTurnBodySchema = z
  .object({
    content: z.string().min(1).max(40_000),
    expectedEditedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const forkBodySchema = z
  .object({
    fromTurnId: z.uuid(),
    title: z.string().min(1).max(500).optional(),
  })
  .strict();

export const turnSchema = tableRow(agentSessionTurns);

export const turnPageSchema = z.object({
  turns: z.array(turnSchema),
  nextCursor: z.string().nullable(),
});

export const regeneratedSchema = z.object({ status: sessionSchema.shape.status });

const notMember = fail('FORBIDDEN', "the caller is below the member role of the session's project");
const noSession = fail('NOT_FOUND', 'no such agent session, project or turn');
const noClient = 'no online chat-capable runner can take the turn';
const running = 'a turn is in flight on the session';

export const listTurns = describeOperation({
  summary: "List a session's turns in order, a page at a time after a cursor turn",
  description: '`nextCursor` is the turn id to pass as `after`; null when the page was the last.',
  responses: {
    200: json(turnPageSchema),
    403: fail(
      'FORBIDDEN',
      "not a member of the session's project, or not the owner of an agent conversation",
    ),
    404: fail('NOT_FOUND', 'no such agent session, or `after` names no turn of it'),
  },
});

export const editTurn = describeOperation({
  summary: "Edit the text of one of the session's own user turns",
  description:
    'Pass `expectedEditedAt` to refuse the write when someone edited the turn since you read it.',
  responses: {
    200: json(turnSchema, 'The turn after the edit'),
    400: fail('TURN_NOT_USER', 'only user turns can be edited'),
    403: fail('FORBIDDEN', 'the caller is below the member role or does not own the session'),
    404: noSession,
    409: fail({
      SESSION_RUNNING: running,
      TURN_STALE: 'the turn was edited since `expectedEditedAt`',
    }),
  },
});

export const regenerateTurn = describeOperation({
  summary: 'Throw away a turn and everything after it, and run the last user prompt again',
  responses: {
    200: json(regeneratedSchema, 'The session status after the dispatch'),
    403: fail('FORBIDDEN', 'the caller is below the member role or does not own the session'),
    404: noSession,
    409: fail({
      SESSION_RUNNING: running,
      NO_DISPATCHABLE_PROMPT: 'no user prompt precedes the turn',
      SESSION_STALE: 'the session changed before the regeneration could start',
      NO_CLAUDE_CLIENT: noClient,
      DEVICE_NOT_BOUND:
        'the device picked has no runner bound to the project, so no checkout of it to run in',
    }),
  },
});

export const forkSession = describeOperation({
  summary: 'Copy a session up to and including a turn into a new chat',
  responses: { 201: json(sessionSchema, 'The new session'), 403: notMember, 404: noSession },
});

export const rerunSession = describeOperation({
  summary: "Start a new chat that replays the session's first user prompt",
  responses: {
    201: json(sessionSchema, 'The new session, with the prompt dispatched'),
    400: fail('NO_PROMPT', 'the session has no user prompt'),
    403: fail('FORBIDDEN', 'the caller does not own the session and is not a project admin'),
    404: noSession,
    409: fail({
      SESSION_RUNNING: running,
      NO_CLAUDE_CLIENT: noClient,
      DEVICE_NOT_BOUND:
        'the device picked has no runner bound to the project, so no checkout of it to run in',
    }),
  },
});
