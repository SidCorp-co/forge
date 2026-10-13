import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/describe.js';

/** Why the probe is a flag per dependency: a monitor reads which one is down. */
export const livenessSchema = z.object({
  ok: z.boolean(),
  db: z.object({ ok: z.boolean() }),
  queue: z.object({ ok: z.boolean() }),
  ws: z.object({ ok: z.boolean() }),
});

export const versionSchema = z.object({
  version: z.string(),
  sourceCommit: z.string().nullable(),
  uptimeSeconds: z.number().int(),
});

const dependencyState = z.enum(['ok', 'down']);

export const opsHealthSchema = z.object({
  version: z.string(),
  uptimeSeconds: z.number().int(),
  db: dependencyState,
  queue: dependencyState,
  ws: dependencyState,
  runners: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      projectId: z.string(),
      status: z.string(),
      lastSeenAt: z.date().nullable(),
      inFlightCount: z.number().int(),
    }),
  ),
  projects: z.array(
    z.object({ id: z.string(), slug: z.string(), activeJobCount: z.number().int() }),
  ),
  stuckJobs: z.array(
    z.object({
      jobId: z.string(),
      type: z.string(),
      runnerId: z.string().nullable(),
      dispatchedAt: z.string().nullable(),
      ageSeconds: z.number().int(),
    }),
  ),
  staleJobThresholdSeconds: z.number().int(),
});

export const probeLiveness = describeOperation({
  summary: 'Say whether the server can reach its database, its queue and its websocket listener',
  description:
    'No sign-in. Answers 200 when all three are up and 503 with the same body when one is not, so a monitor reads the status and a person reads which dependency failed.',
  responses: {
    200: json(livenessSchema, 'Every dependency is up'),
    503: json(livenessSchema, 'At least one dependency is down'),
  },
});

export const readVersion = describeOperation({
  summary: 'Read the running version, the commit it was built from and its uptime',
  description: 'No sign-in. `sourceCommit` is null where the build did not record one.',
  responses: { 200: json(versionSchema) },
});

export const readProjectOpsHealth = describeOperation({
  summary: 'Read the ops snapshot of one project: dependencies, runners and stuck jobs',
  description:
    'A snapshot that reports the database as down still answers 200, with the legs that need it left empty.',
  responses: {
    200: json(opsHealthSchema),
    403: fail('FORBIDDEN', 'the caller is not a member of the project'),
    404: fail('NOT_FOUND', 'the project does not exist'),
  },
});

export const readMyOpsHealth = describeOperation({
  summary: 'Read the ops snapshot across every project the caller can see',
  responses: { 200: json(opsHealthSchema) },
});
