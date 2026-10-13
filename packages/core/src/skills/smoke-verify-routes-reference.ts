import { z } from 'zod';
import {
  describeOperation,
  fail,
  json,
  NO_SUCH_PROJECT,
} from '../api-reference/declare/describe.js';
import { issueStatuses } from '../db/schema.js';

const verdictSchema = z.enum(['PASS', 'FAIL']);

const reportSchema = z.object({
  projectId: z.string(),
  generatedAt: z.string(),
  tier1: z
    .array(
      z.object({
        stage: z.enum(issueStatuses),
        skillId: z.string().nullable(),
        skillName: z.string().nullable(),
        status: verdictSchema,
        reason: z
          .enum(['no_project_skill', 'no_bound_runner', 'no_device_report', 'stale_on_runner'])
          .nullable(),
        detail: z.string().nullable(),
        checkedAt: z.string().describe('When the static check ran: always now'),
        evidenceAt: z.string().nullable().describe('For PASS, the newest sync backing it'),
      }),
    )
    .describe('The static checks, one per registered stage, computed fresh'),
  tier2: z
    .array(
      z.object({
        stage: z.string(),
        jobId: z.string(),
        status: z.enum(['PASS', 'FAIL', 'PENDING']),
        reason: z.string().nullable(),
        queuedAt: z.string(),
        checkedAt: z.string().nullable().describe('Null while PENDING'),
      }),
    )
    .describe('The latest canary outcome per stage; empty until one is requested'),
});

export const smokeReportSchema = reportSchema;

export const smokeRunSchema = z.object({
  report: reportSchema,
  canary: z
    .object({
      dispatched: z.array(
        z.object({ stage: z.string(), jobId: z.string(), skillName: z.string() }),
      ),
      skipped: z.array(z.object({ stage: z.string(), reason: z.string() })),
    })
    .nullable()
    .describe('Null for a tier-1 run, which dispatches nothing'),
});

export const readSmokeVerify = describeOperation({
  summary: 'Read whether the skill of each stage is registered, synced and usable',
  responses: {
    200: json(smokeReportSchema),
    403: fail('FORBIDDEN', 'the caller is not a project member'),
    404: NO_SUCH_PROJECT,
  },
});

export const runSmokeVerify = describeOperation({
  summary: 'Run the smoke check; tier 2 also queues a canary job per usable stage',
  description:
    'Tier 1 reads the registrations and what the devices installed. Tier 2 needs a project admin and a runner online, and appears in the report as PENDING until each canary finishes.',
  responses: {
    200: json(smokeRunSchema, 'The report, and the canaries dispatched or skipped for tier 2'),
    403: fail('FORBIDDEN', 'the caller is not a member, or is no admin for a tier-2 run'),
    409: fail(
      'NO_RUNNER_ONLINE',
      'no runner is online for the project, so a canary would queue forever',
    ),
    404: NO_SUCH_PROJECT,
  },
});
