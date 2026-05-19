// Response schema for `GET /api/pipeline/registry`. The runtime literal +
// derived constants live in `@forge/core/src/pipeline/registry.ts`; this
// file is the client-facing Zod contract.
//
// Enum tuples are hardcoded locally rather than imported from core because
// `@forge/core/public` has side effects at module load (env validation in
// `src/config/env.ts`). Importing it at runtime in a browser or test
// without `DATABASE_URL`/`JWT_SECRET` set would throw. A parity test in
// `packages/core/src/pipeline/registry.test.ts` keeps these tuples in sync
// with `core/db/schema.ts` and `core/pipeline/pipeline-config-schema.ts`.

import { z } from 'zod';

export const REGISTRY_ISSUE_STATUSES = [
  'open',
  'confirmed',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
  'tested',
  'pass',
  'staging',
  'released',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
] as const;

export const REGISTRY_JOB_TYPES = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'release',
  'fix',
  'custom',
  'pm',
] as const;

export const REGISTRY_RUNNER_TYPES = ['claude-code', 'antigravity'] as const;

export const REGISTRY_STEP_TOGGLE_KEYS = [
  'autoTriage',
  'autoClarify',
  'autoPlan',
  'autoCode',
  'autoReview',
  'autoTest',
  'autoFix',
  'autoRelease',
] as const;

export const pipelineStepSchema = z.object({
  status: z.enum(REGISTRY_ISSUE_STATUSES),
  jobType: z.enum(REGISTRY_JOB_TYPES),
  toggle: z.enum(REGISTRY_STEP_TOGGLE_KEYS),
  skillName: z.string().min(1),
});
export type PipelineStep = z.infer<typeof pipelineStepSchema>;

export const pipelineRegistryResponseSchema = z.object({
  version: z.number().int().positive(),
  steps: z.array(pipelineStepSchema),
  runnerCapabilities: z.record(z.enum(REGISTRY_RUNNER_TYPES), z.array(z.enum(REGISTRY_JOB_TYPES))),
  manualOnlyJobTypes: z.array(z.enum(REGISTRY_JOB_TYPES)),
});
export type PipelineRegistryResponse = z.infer<typeof pipelineRegistryResponseSchema>;
