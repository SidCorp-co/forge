import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import {
  agentSessionStatuses,
  pipelineRunStatuses,
  scheduleStatuses,
  schedules,
} from '../db/schema.js';

const scheduleSchema = tableRow(schedules);

export const scheduleListSchema = z.array(scheduleSchema);
export { scheduleSchema };

const stewardReportSchema = z.object({
  weakestDomain: z.string(),
  skillsAssessed: z.array(z.string()),
  actions: z.array(
    z.object({
      skill: z.string(),
      kind: z.enum(['proposed', 'applied', 'feedback', 'skipped']),
      summary: z.string(),
    }),
  ),
  memoryWrites: z.array(
    z.object({ skill: z.string(), sourceRef: z.string(), tokensAfter: z.number() }),
  ),
  idempotencySkips: z.array(z.string()),
});

/** A prompt-kind run is an agent session under a pipeline run; a runner-less kind keeps its own row. */
const sessionRunSchema = z.object({
  sessionId: z.string(),
  pipelineRunId: z.string().nullable(),
  status: z.enum(agentSessionStatuses),
  runStatus: z.enum(pipelineRunStatuses).nullable(),
  trigger: z.enum(['scheduled', 'manual']),
  title: z.string().nullable(),
  failureReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  stewardReport: stewardReportSchema.nullable(),
});

const runnerLessRunSchema = z.object({
  sessionId: z.string(),
  pipelineRunId: z.null(),
  status: z.enum(scheduleStatuses),
  runStatus: z.enum(scheduleStatuses),
  trigger: z.enum(['manual', 'scheduled']),
  title: z.null(),
  failureReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  stewardReport: z.null(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});

export const scheduleRunsSchema = z.object({
  runs: z.array(z.union([sessionRunSchema, runnerLessRunSchema])),
});

export const scheduleTriggeredSchema = z.object({ sessionId: z.string(), message: z.string() });

const NO_SCHEDULE = 'no such schedule';
const BAD_REFERENCE = {
  BAD_REQUEST:
    '`templateKey` is not in the improvement-message registry, or the schedule would end with no `script` (kind `script`) or no `prompt` (kind `prompt`)',
  INVALID_CRON: '`cron` is not a valid cron expression',
  INVALID_TARGET_PROJECT: '`targetProjectSlug` names no project',
} as const;

export const listProjectSchedules = describeOperation({
  summary: "List a project's schedules, oldest first",
  description: 'Filter with `enabled=true|false`.',
  responses: {
    200: json(scheduleListSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
  },
});

export const readSchedule = describeOperation({
  summary: 'Read one schedule',
  responses: {
    200: json(scheduleSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the schedule's project"),
    404: fail('NOT_FOUND', NO_SCHEDULE),
  },
});

export const listRuns = describeOperation({
  summary: "Read a schedule's run history, newest first",
  description:
    'At most `limit` runs, 20 when it is absent. A cron-driven run reports trigger `scheduled`, a manual one `manual`.',
  responses: {
    200: json(scheduleRunsSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the schedule's project"),
    404: fail('NOT_FOUND', NO_SCHEDULE),
  },
});

export const createScheduleOp = describeOperation({
  summary: 'Create a schedule on a project',
  description:
    'A prompt-kind schedule needs `prompt`, a script-kind one `script`; `release_batch` and `sentry_pull` take neither. Next run is computed from `cron` when enabled.',
  responses: {
    201: json(scheduleSchema, 'The schedule as created'),
    400: fail(BAD_REFERENCE),
    403: fail(
      'FORBIDDEN',
      'the caller is not a project admin, or is not a member of the target project',
    ),
  },
});

export const updateScheduleOp = describeOperation({
  summary: 'Change a schedule',
  description: 'Only the fields sent change. Changing `cron` or `enabled` recomputes the next run.',
  responses: {
    200: json(scheduleSchema, 'The schedule as updated'),
    400: fail(BAD_REFERENCE),
    403: fail(
      'FORBIDDEN',
      'the caller is not a project admin, or is not a member of the target project',
    ),
    404: fail('NOT_FOUND', NO_SCHEDULE),
  },
});

export const deleteScheduleOp = describeOperation({
  summary: 'Delete a schedule',
  responses: {
    204: empty('Deleted'),
    403: fail('FORBIDDEN', 'the caller is not a project admin'),
    404: fail('NOT_FOUND', NO_SCHEDULE),
  },
});

export const runScheduleOp = describeOperation({
  summary: 'Run a schedule now',
  description: 'Starts the run and answers with the session; it does not wait for it to finish.',
  responses: {
    202: json(scheduleTriggeredSchema, 'The run was started'),
    400: fail('INVALID_TARGET_PROJECT', "the schedule's `targetProjectSlug` names no project"),
    403: fail(
      'FORBIDDEN',
      'the caller is not a project member, or is not a member of the target project',
    ),
    404: fail('NOT_FOUND', NO_SCHEDULE),
    409: fail(
      'SCHEDULE_DISPATCH_FAILED',
      'nothing was started: no device is online, the project is gone, the run was already applied, or the session failed to start',
    ),
  },
});
