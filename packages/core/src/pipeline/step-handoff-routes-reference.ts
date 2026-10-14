import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { issueStepContexts } from '../db/schema.js';
import { stepHandoffSchema } from '../memory/step-handoff-schema.js';

const NOT_MEMBER = 'the caller is not a member of the project';

export const handoffWrittenSchema = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** A stored handoff: the row, with the payload as the step wrote it. */
export const handoffRowSchema = tableRow(issueStepContexts).extend({ payload: stepHandoffSchema });

export const handoffListSchema = z.object({ rows: z.array(handoffRowSchema) });

export const handoffDeletedSchema = z.object({ deleted: z.boolean() });

export const writeHandoff = describeOperation({
  summary: "Write a step's handoff for an issue; the same issue, step and attempt is replaced",
  description:
    "The payload's `step` must be the one named in the body. Mirrors the `forge_step_handoff` write tool.",
  responses: {
    201: json(handoffWrittenSchema, 'The row id and its timestamps'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', 'the issue is not in `projectId`'),
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
  summary: 'Delete the handoff for an issue, step and attempt',
  description: '`deleted` is false when there was no such handoff.',
  responses: {
    200: json(handoffDeletedSchema),
    403: fail('FORBIDDEN', NOT_MEMBER),
  },
});
