// What an environment runs now, as `GET /api/projects/:id/environments/:name/state` answers it
// (`environment-state.ts`): kept beside the project document's schema, which declares the probes.

import { z } from 'zod';
import { deploymentProviderSchema, httpsUrl, slug } from './schema.js';

const observedIdentity = () => z.string().min(1).max(200);
const probeIdentity = { url: httpsUrl(), identifies: z.enum(['source', 'artifact']) };

const probeOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...probeIdentity,
    status: z.literal('confirmed'),
    observed: observedIdentity(),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('mismatch'),
    observed: observedIdentity(),
    expected: observedIdentity(),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('uncompared'),
    observed: observedIdentity(),
    error: z.string().min(1).max(500),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('unreachable'),
    error: z.string().min(1).max(500),
  }),
]);

const unknownEnvironmentStateSchema = z.strictObject({
  environment: slug(),
  state: z.literal('unknown'),
  evidence: z.literal('none'),
  reason: z.strictObject({
    cause: z.enum(['external', 'no-record', 'adapter-error', 'binding-refused', 'probe-unread']),
    message: z.string().min(1).max(1000),
  }),
});

const recordedEnvironmentStateSchema = z.strictObject({
  environment: slug(),
  state: z.enum(['deployed', 'deploying', 'failed', 'cancelled']),
  evidence: z.enum([
    'runtime-confirmed',
    'runtime-mismatch',
    'runtime-unreachable',
    'deployment-record',
  ]),
  deployment: z.strictObject({
    id: z.string().min(1).max(100),
    provider: deploymentProviderSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    at: z.iso.datetime({ offset: true }),
  }),
  release: z
    .strictObject({ id: z.string().min(1).max(100) })
    .nullable()
    .optional(),
  artifact: z
    .strictObject({
      kind: z.enum(['container-image', 'theme', 'bundle']),
      id: z.string().min(1).max(200),
    })
    .nullable(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('revision'), revision: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    z.strictObject({ kind: z.literal('unrecorded') }),
    z.strictObject({ kind: z.literal('non-git') }),
  ]),
  probes: z.array(probeOutcomeSchema).min(1).max(3).optional(),
});

// an environment deployed outside Forge keeps no deployment record here, so what its declared source
// probes agree on is the one reading there is of what it serves
const servingEnvironmentStateSchema = z.strictObject({
  environment: slug(),
  state: z.literal('serving'),
  evidence: z.literal('runtime-probe'),
  source: z.strictObject({
    kind: z.literal('revision'),
    revision: z.string().regex(/^[0-9a-f]{7,40}$/),
  }),
  probes: z.array(probeOutcomeSchema).min(1).max(3),
});

export const environmentStateSchema = z.discriminatedUnion('state', [
  unknownEnvironmentStateSchema,
  recordedEnvironmentStateSchema,
  servingEnvironmentStateSchema,
]);

export type EnvironmentState = z.infer<typeof environmentStateSchema>;
export type RecordedEnvironmentState = z.infer<typeof recordedEnvironmentStateSchema>;
export type ServingEnvironmentState = z.infer<typeof servingEnvironmentStateSchema>;
export type ProbeOutcomeState = z.infer<typeof probeOutcomeSchema>;
