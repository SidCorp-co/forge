import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/declare/describe.js';
import {
  devicePlatforms,
  deviceStatuses,
  runnerLimitReasons,
  runnerProvisionStatuses,
  runnerStatuses,
} from '../db/schema.js';
import { poolReadVerdicts } from '../devices/pool-read-report.js';

/** `runners.labels` is an untyped jsonb column that every writer fills with a list of strings. */
const labelsSchema = z.unknown().meta({ type: 'array', items: { type: 'string' } });

const poolReadSchema = z
  .object({
    projectId: z.string(),
    verdict: z.enum(poolReadVerdicts),
    failures: z.number(),
    countIsFloor: z.boolean(),
    windowMs: z.number(),
    unreadSince: z.number().nullable(),
    consecutive: z.number(),
    recoveredAt: z.number().nullable(),
    lastFailure: z.object({
      at: z.number(),
      status: z.number().nullable(),
      what: z.string(),
      reason: z.string(),
    }),
    receivedAt: z.string(),
  })
  .nullable();

const runnerListRowSchema = z.object({
  runnerId: z.string(),
  deviceId: z.string(),
  deviceName: z.string().nullable(),
  platform: z.enum(devicePlatforms).nullable(),
  deviceStatus: z.enum(deviceStatuses).nullable(),
  agentVersion: z.string().nullable(),
  deviceDisabledAt: z.date().nullable(),
  runnerStatus: z.enum(runnerStatuses),
  lastError: z.string().nullable(),
  limitReason: z.enum(runnerLimitReasons).nullable(),
  rateLimitedUntil: z.date().nullable(),
  limitDetail: z.string().nullable(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  labels: labelsSchema,
  lastSeenAt: z.date().nullable(),
  provisionStatus: z.enum(runnerProvisionStatuses).nullable(),
  provisionDetail: z.string().nullable(),
  provisionedAt: z.date().nullable(),
  provisionStatusAt: z.date(),
  poolRead: poolReadSchema,
  residentMaster: z
    .object({ sessionId: z.string(), name: z.string(), lastHeartbeatAt: z.string().nullable() })
    .nullable(),
  provisionStalledSeconds: z.number().nullable(),
});

export const runnerListSchema = z.array(runnerListRowSchema);

/** A runner binding as a write answers with it. */
export const runnerBindingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  deviceId: z.string(),
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  labels: labelsSchema,
  status: z.enum(runnerStatuses),
});

export const runnerFaultsClearedSchema = z.object({
  runnerId: z.string(),
  cleared: z.boolean(),
});

const NEEDS_ADMIN = fail('FORBIDDEN', 'the caller is not a project admin');
const NO_PROJECT = 'the project does not exist';

export const listProjectRunners = describeOperation({
  summary: 'List the runners bound to a project, with their device and provisioning state',
  description:
    'One row per device that serves the project. `provisionStalledSeconds` is set when a provision has stood in flight with nothing written. Any member may read it.',
  responses: {
    200: json(runnerListSchema, 'The runner bindings'),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});

export const bindRunner = describeOperation({
  summary: 'Bind a device to the project as a runner, and queue provisioning of its checkout',
  description:
    'An upsert: binding a device that is bound already updates the binding and queues provisioning again.',
  responses: {
    201: json(runnerBindingSchema, 'The runner binding'),
    403: NEEDS_ADMIN,
    404: fail({ NOT_FOUND: NO_PROJECT, DEVICE_NOT_FOUND: 'no device has this id' }),
    409: fail(
      'PROVISION_WORKSPACE_IN_USE',
      'the device holds a live resident master for the project, which is running in the checkout',
    ),
    500: fail('RUNNER_UPSERT_FAILED', 'the upsert returned no row'),
  },
});

export const updateRunner = describeOperation({
  summary: "Change a runner's checkout path, branch, capabilities or labels",
  responses: {
    200: json(runnerBindingSchema, 'The runner binding after the change'),
    403: NEEDS_ADMIN,
    404: fail({
      NOT_FOUND: NO_PROJECT,
      RUNNER_NOT_FOUND: 'the project has no runner with this id',
    }),
  },
});

export const clearRunnerError = describeOperation({
  summary: "Clear a runner's error, usage-limit and quarantine flags",
  description: '`cleared` is false when the runner carried none of them.',
  responses: {
    200: json(runnerFaultsClearedSchema, 'Whether anything was cleared'),
    403: NEEDS_ADMIN,
    404: fail({
      NOT_FOUND: NO_PROJECT,
      RUNNER_NOT_FOUND: 'the project has no runner with this id',
    }),
  },
});

export const unbindRunner = describeOperation({
  summary: 'Remove a runner binding from the project',
  description:
    'Idempotent: the answer is 204 whether or not the runner existed. Other projects on the same device are untouched.',
  responses: {
    204: empty('The binding is gone'),
    403: NEEDS_ADMIN,
    404: fail('NOT_FOUND', NO_PROJECT),
  },
});
