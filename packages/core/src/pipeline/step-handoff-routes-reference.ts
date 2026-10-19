import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { stepHandoffSchema } from '../memory/step-handoff-schema.js';

const NOT_MEMBER = 'the caller is not a member of the project';

export const handoffWrittenSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** A stored handoff: its attempt on the run journal, with the payload as the step wrote it. */
export const handoffRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  issueId: z.string(),
  pipelineRunId: z.string(),
  kind: z.literal('handoff'),
  step: z.string().nullable(),
  attempt: z.number(),
  payload: stepHandoffSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const handoffListSchema = z.object({ rows: z.array(handoffRowSchema) });

export const writeHandoff = describeOperation({
  summary: "Write the handoff of one run's step attempt, once",
  description:
    "The payload's `step` must be the one named in the body. It lands on the run journal's row for (`pipelineRunId`, `step`, `attempt`), appended closed where the run never declared that attempt. Mirrors the `forge_step_handoff` write tool.",
  responses: {
    201: json(handoffWrittenSchema, 'The row id and its timestamps'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail(
      'NOT_FOUND',
      'the issue is not in `projectId`, or `pipelineRunId` names no run in it',
    ),
    409: fail({
      HANDOFF_ALREADY_WRITTEN: 'the attempt already holds its handoff, which stands',
      HANDOFF_NOT_THIS_ISSUE: "the attempt is another issue's",
    }),
  },
});

export const listHandoffs = describeOperation({
  summary: "List an issue's step handoffs, newest first unless `orderDir` says otherwise",
  description:
    '`issueId` takes a uuid or the display key (`ISS-12`); `steps` is a comma-separated allow-list.',
  responses: {
    200: json(handoffListSchema),
    400: fail('BAD_REQUEST', '`issueId` is not a uuid or a display key the project can read'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', 'the key names no issue in the project'),
  },
});

export const deleteHandoff = describeOperation({
  summary: "Refused: a handoff is the run journal's record of its attempt and is not deleted",
  description:
    'Kept so a caller of the old surface is told why, by name, rather than met with a 404.',
  retired: 'a handoff is its attempt on the run journal, which keeps every attempt (ISS-1133)',
  responses: {
    403: fail('FORBIDDEN', NOT_MEMBER),
    409: fail('HANDOFF_IS_JOURNAL', 'the journal keeps every attempt, so nothing was deleted'),
  },
});
