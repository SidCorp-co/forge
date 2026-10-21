import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { jobStatuses } from '../db/schema.js';
import { schemaRefused } from '../lib/zod-sentences.js';
import { blockedEndSchema } from './blocked-routes-reference.js';
import { salvageSchema } from './prior-attempts.js';

export const jobIdParamSchema = z.object({ id: z.uuid() });

export const ackBodySchema = z.object({
  skillsRanWith: z.record(z.string(), z.string().max(128)).optional(),
});

export const completeBodySchema = z
  .object({
    exitCode: z.number().int(),
    error: z.string().max(10_000).nullable().optional(),
    summary: z.string().max(10_000).optional(),
  })
  .strict();

export const failBodySchema = z
  .object({ error: z.string().max(10_000), salvage: salvageSchema.optional() })
  .strict();

export const cancelBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * The optional `{ reason }` body of a cancel or a resume. An empty or absent body (the cancel
 * button sends none) counts as `{}`; anything else is held to `cancelBodySchema`.
 */
export async function readReasonBody(req: {
  json(): Promise<unknown>;
}): Promise<{ reason?: string | undefined }> {
  const raw = await req.json().catch(() => ({}));
  const parsed = cancelBodySchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  throw schemaRefused(parsed.error, cancelBodySchema, raw);
}

export const killAckBodySchema = z
  .object({
    outcome: z.enum(['killed', 'not_found']),
  })
  .strict();

const jobStatus = z.enum(jobStatuses);

/** Whether a retry was scheduled for a failed job, and why not when it was not. */
export const retryOutcomeSchema = z.object({
  scheduled: z.boolean(),
  newJobId: z.string().optional(),
  reason: z.string().optional(),
});

export const ackedSchema = z.object({
  jobId: z.string(),
  status: jobStatus,
  ackedAt: z.string().nullable(),
  acked: z.boolean(),
});

export const completedSchema = z.object({
  jobId: z.string(),
  status: jobStatus,
  exitCode: z.number().nullable(),
  retry: retryOutcomeSchema.nullable(),
  reconciled: z.literal(true).optional(),
});

export const failedSchema = z.union([
  z.object({
    jobId: z.string(),
    status: jobStatus,
    error: z.string().nullable(),
    retry: retryOutcomeSchema,
  }),
  blockedEndSchema.extend({
    error: z.string(),
    retry: z.object({ scheduled: z.literal(false), reason: z.string() }),
  }),
]);

export const killAckedSchema = z.object({
  jobId: z.string(),
  killOutcome: z.enum(['killed', 'not_found']),
  acked: z.literal(true),
  recorded: z.boolean(),
});

export const cancelledSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  cancellationRequested: z.boolean(),
});

export const resumedSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  heldReason: z.string().nullable(),
});

const noJob = fail('NOT_FOUND', 'no such job');
const notYours = fail('FORBIDDEN', 'the job is not dispatched to this device');
const notRunnable = fail('INVALID_STATE', 'the job is no longer out with a box');

export const ackJob = describeOperation({
  summary: 'Acknowledge that the box has the job, before it starts the agent',
  description:
    'Idempotent: a repeat keeps the first timestamp and answers `acked: false`. A job that already ended is not an error.',
  responses: { 200: json(ackedSchema), 403: notYours, 404: noJob },
});

export const completeJob = describeOperation({
  summary: 'Report that the box finished a job, by exit code',
  description:
    'Exit 0 is done and -1 cancelled; anything else fails the job and schedules a retry where policy allows. A late success for a job already reaped as failed is accepted when no retry took over (`reconciled`).',
  responses: { 200: json(completedSchema), 403: notYours, 404: noJob, 409: notRunnable },
});

export const failJob = describeOperation({
  summary: 'Report that the box failed a job, with what it salvaged',
  description:
    'An error naming a pane stopped on a question ends the job as blocked: the question is raised and nothing retries.',
  responses: { 200: json(failedSchema), 403: notYours, 404: noJob, 409: notRunnable },
});

export const killAckJob = describeOperation({
  summary: 'Confirm whether the box killed a job it was told to cancel',
  description:
    '`recorded` is false when no kill had been requested: the ack is audited, not stamped.',
  responses: { 200: json(killAckedSchema), 403: notYours, 404: noJob },
});

export const cancelJob = describeOperation({
  summary: 'Cancel a live job',
  description:
    'Needs the project member role, or a platform administrator. A job out with a box is asked to stop and cancels when the box confirms.',
  responses: {
    200: json(cancelledSchema),
    400: fail(
      'BAD_REQUEST',
      'the body names a field other than `reason`, or `reason` is over 500 characters',
    ),
    401: fail('UNAUTHENTICATED', 'the caller no longer exists'),
    403: fail({
      ADMIN_ONLY: 'the caller is below the member role and not a platform administrator',
      FORBIDDEN: "the caller is not a member of the job's project",
    }),
    404: noJob,
    409: fail('NOT_CANCELLABLE', 'the job is not queued or running, or changed state mid-request'),
  },
});

export const retriedSchema = z.object({
  jobId: z.string(),
  retryOf: z.string(),
  status: z.literal('queued'),
});

/** A person retries a failed job: a fresh queued job that names the one it retries (ISS-1229 r16). */
export const retryJob = describeOperation({
  summary: 'Queue a failed job again, as a new job that names the one it retries',
  responses: {
    200: json(retriedSchema),
    400: fail(
      'BAD_REQUEST',
      'the body names a field other than `reason`, or `reason` is over 500 characters',
    ),
    403: fail(
      'FORBIDDEN',
      "the caller holds less than the member role on the job's project; the refusal names the role it holds",
    ),
    404: noJob,
    409: fail({
      NOT_FAILED: 'the job is not failed; a held job is resumed, a live one is left to finish',
      ALREADY_RETRIED: 'the job was already retried; its successor is the one to follow',
      ISSUE_RESOLVED: 'the issue the job ran for is finished',
      ISSUE_ARCHIVED: 'the issue the job ran for is archived',
      ALREADY_ACTIVE: 'a job of the same kind is already queued or running on the issue',
      RUN_CLOSED: 'the job ran in a closed run and for no issue to open a run on',
    }),
  },
});

export const resumeJob = describeOperation({
  summary: 'Put a held job back on the queue, overriding the condition that held it',
  responses: {
    200: json(resumedSchema),
    400: fail(
      'BAD_REQUEST',
      'the body names a field other than `reason`, or `reason` is over 500 characters',
    ),
    403: fail('FORBIDDEN', "the caller is not a member of the job's project"),
    404: noJob,
    409: fail({
      NOT_HELD: 'the job is not held, or changed state mid-request',
      DECISION_OPEN: 'the job waits on open questions; answer them and it goes on by itself',
    }),
  },
});
