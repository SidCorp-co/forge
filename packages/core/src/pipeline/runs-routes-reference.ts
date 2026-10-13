import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { pipelineRuns } from '../db/schema.js';

const runSchema = tableRow(pipelineRuns);

export const cancelResultSchema = z.object({
  run: runSchema,
  cancelledJobIds: z.array(z.string()),
  abortedSessionIds: z.array(z.string()),
  deviceIdsNotified: z.array(z.string()),
  issueParked: z.boolean(),
});

export { runSchema as pipelineRunRowSchema };

const NOT_MEMBER = 'the caller is below the project member role';
const NO_RUN = 'no such pipeline run';

export const pauseRun = describeOperation({
  summary: 'Pause a running pipeline run',
  description: 'Pausing a run that is already paused answers the run as it is.',
  responses: {
    200: json(runSchema, 'The run, paused'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
    409: fail('run_terminal', 'the run has already ended'),
  },
});

export const resumeRun = describeOperation({
  summary: 'Resume a paused pipeline run',
  description: 'Resuming a run that is already running answers the run as it is.',
  responses: {
    200: json(runSchema, 'The run, running'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
    409: fail('run_terminal', 'the run has already ended'),
  },
});

export const cancelRun = describeOperation({
  summary: 'Cancel a pipeline run and the jobs and sessions under it',
  description:
    'By default the linked issue is parked at `on_hold`; send `parkIssue: false` to cancel so a clean run can start. Cancelling a run that is already cancelled answers it with nothing cascaded.',
  responses: {
    200: json(cancelResultSchema, 'The run, and what the cancel stopped'),
    403: fail('FORBIDDEN', NOT_MEMBER),
    404: fail('NOT_FOUND', NO_RUN),
    409: fail('run_terminal', 'the run has already ended some other way'),
  },
});
