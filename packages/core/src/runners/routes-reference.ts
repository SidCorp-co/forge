import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import {
  agentSessions,
  runnerLimitReasons,
  runnerStatuses,
  type runners,
  runnerTypes,
} from '../db/schema.js';
import type { Runner } from './types.js';

export const createBody = z
  .object({
    projectId: z.uuid(),
    type: z.enum(runnerTypes),
    name: z.string().min(1).max(120),
    deviceId: z.uuid(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['draining', 'disabled', 'offline', 'online']).optional(),
  })
  .strict();

export const idParam = z.object({ id: z.uuid() });

export const listQuery = z.object({
  projectId: z.uuid().optional(),
  type: z.enum(runnerTypes).optional(),
  status: z.enum(runnerStatuses).optional(),
});

export const activeQuery = z.object({ projectId: z.uuid() });

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/** A runner as it is shown: `apiKey` and `callbackSecret` in `config` are masked as `***`. */
export const runnerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: z.enum(runnerTypes),
  deviceId: z.string().nullable(),
  name: z.string(),
  labels: z.array(z.string()),
  capabilities: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(runnerStatuses),
  lastSeenAt: z.date().nullable(),
  lastError: z.string().nullable(),
  limitReason: z.enum(runnerLimitReasons).nullable(),
  rateLimitedUntil: z.date().nullable(),
  limitDetail: z.string().nullable(),
  quarantinedUntil: z.date().nullable(),
  quarantineReason: z.string().nullable(),
});

export function rowToRunner(r: typeof runners.$inferSelect): Runner {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    deviceId: r.deviceId,
    name: r.name,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    config: (r.config ?? {}) as Record<string, unknown>,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
    limitReason: r.limitReason,
    rateLimitedUntil: r.rateLimitedUntil,
    limitDetail: r.limitDetail,
    quarantinedUntil: r.quarantinedUntil,
    quarantineReason: r.quarantineReason,
  };
}

export function publicRunner(
  r: Runner,
): Omit<Runner, 'config'> & { config: Record<string, unknown> } {
  const config = { ...r.config };
  if ('apiKey' in config) config.apiKey = '***';
  if ('callbackSecret' in config) config.callbackSecret = '***';
  return { ...r, config };
}

export const runnerTypesSchema = z.object({
  types: z.array(
    z.object({
      type: z.string(),
      configSchema: z.string().nullable().describe('`<zod>` where the type has a config schema'),
    }),
  ),
});

export const runnerListSchema = z.object({ runners: z.array(runnerSchema) });
export const runnerOneSchema = z.object({ runner: runnerSchema });

export const activeRunnersSchema = z.object({
  runners: z.array(
    z.object({
      runnerId: z.string(),
      name: z.string(),
      status: z.string(),
      lastSeenAt: z.string().nullable(),
      current: z
        .object({
          jobId: z.string(),
          stage: z.string().nullable(),
          startedAt: z.string().nullable(),
          issueId: z.string().nullable(),
          issueRef: z.string().nullable(),
          issueTitle: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  busy: z.number(),
  total: z.number(),
});

export const runnerActivitySchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      oldStatus: z.string().nullable(),
      newStatus: z.string(),
      reason: z.string().nullable(),
      ts: z.date(),
    }),
  ),
  sessions: z.array(
    tableRow(agentSessions)
      .pick({ id: true, title: true, status: true, failureReason: true, updatedAt: true })
      .extend({ errorExcerpt: z.string().nullable() }),
  ),
  retentionDays: z.number().nullable(),
});

export const okSchema = z.object({ ok: z.literal(true) });

export const healthSchema = z.object({
  ok: z.boolean(),
  lastError: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const quotaSchema = z.object({
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const noRunner = fail('NOT_FOUND', 'no such runner, or its project');
const notMember = fail('FORBIDDEN', "the caller is not a member of the runner's project");
const notAdmin = fail('FORBIDDEN', 'the caller is below the project admin role');
const noAdapter = fail('BAD_REQUEST', 'no adapter is registered for the runner type');

export const listRunnerTypesRoute = describeOperation({
  summary: 'List the runner types this core has an adapter for',
  responses: { 200: json(runnerTypesSchema) },
});

export const listRunners = describeOperation({
  summary: "List a project's runners with secrets in `config` masked",
  description: 'Without `projectId` the list is empty.',
  responses: {
    200: json(runnerListSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project'),
  },
});

export const listActiveRunners = describeOperation({
  summary: "List a project's runners with the job each is running now",
  responses: {
    200: json(activeRunnersSchema),
    403: notMember,
    404: fail('NOT_FOUND', 'no such project'),
  },
});

export const readRunner = describeOperation({
  summary: 'Read one runner',
  responses: { 200: json(runnerOneSchema), 403: notMember, 404: noRunner },
});

export const readRunnerActivity = describeOperation({
  summary: "Read a runner's status changes and the recent sessions that ran on its device",
  responses: { 200: json(runnerActivitySchema), 403: notMember, 404: noRunner },
});

export const createRunner = describeOperation({
  summary: 'Bind a device to a project as a runner of a given type',
  responses: {
    201: json(runnerOneSchema, 'The new runner'),
    400: fail('BAD_REQUEST', "no adapter for the type, or `config` fails the adapter's schema"),
    403: notAdmin,
    404: fail('NOT_FOUND', 'no such project'),
    409: fail('RUNNER_ALREADY_BOUND', 'the device already binds this project as this type'),
  },
});

export const patchRunner = describeOperation({
  summary: "Change a runner's name, labels, capabilities, config or status",
  description: "`config` is merged over the stored one and validated by the type's adapter.",
  responses: {
    200: json(runnerOneSchema, 'The runner after the change'),
    400: fail('BAD_REQUEST', 'no adapter for the type, or the merged `config` fails its schema'),
    403: notAdmin,
    404: noRunner,
  },
});

export const deleteRunner = describeOperation({
  summary: 'Delete a runner',
  responses: { 200: json(okSchema), 403: notAdmin, 404: noRunner },
});

export const checkRunnerHealth = describeOperation({
  summary: "Ask the runner's adapter whether it is healthy, with how its build compares",
  responses: { 200: json(healthSchema), 400: noAdapter, 403: notMember, 404: noRunner },
});

export const refreshRunnerQuota = describeOperation({
  summary: "Ask the runner's adapter for its remaining quota and store it on the runner",
  description: 'An adapter with no quota answers `remaining: null, limit: null`.',
  responses: {
    200: json(quotaSchema),
    403: fail('FORBIDDEN', 'the caller is below the project member role'),
    404: noRunner,
  },
});

export const excludeRunner = describeOperation({
  summary: 'Take a runner out of dispatch by disabling it',
  responses: { 200: json(okSchema), 403: notAdmin, 404: noRunner },
});

export const includeRunner = describeOperation({
  summary: 'Put an excluded runner back, offline until it reports in',
  responses: { 200: json(okSchema), 403: notAdmin, 404: noRunner },
});

export const clearRunnerQuarantineRoute = describeOperation({
  summary: "Lift a runner's quarantine",
  responses: { 200: json(okSchema), 403: notAdmin, 404: noRunner },
});
