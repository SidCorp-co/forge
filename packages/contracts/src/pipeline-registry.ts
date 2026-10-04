// Response schema for `GET /api/pipeline/registry`. The runtime literal +
// derived constants live in `@forge/core/src/pipeline/registry.ts`; this
// file is the client-facing Zod contract.
//
// The issue statuses are the issue machine's (`issue-machine.ts`).

import { z } from 'zod';
import { ISSUE_STATUSES, type IssueStatus } from './issue-machine.js';

export const REGISTRY_JOB_TYPES = [
  'triage',
  'clarify',
  'plan',
  'code',
  'review',
  'test',
  'staging',
  'release',
  'fix',
  'custom',
  'pm',
  'smoke',
  'release_batch',
  'drive',
  'onboarding',
] as const;

export const REGISTRY_RUNNER_TYPES = ['claude-code'] as const;

export const REGISTRY_ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

export const REGISTRY_ISSUE_COMPLEXITIES = ['xs', 's', 'm', 'l', 'xl'] as const;

export const REGISTRY_PIPELINE_RUN_KINDS = ['issue', 'pm', 'interactive', 'system'] as const;

export const pipelineRegistryResponseSchema = z.object({
  version: z.number().int().positive(),
  runnerCapabilities: z.record(z.enum(REGISTRY_RUNNER_TYPES), z.array(z.enum(REGISTRY_JOB_TYPES))),
  statusExits: z
    .record(z.enum(ISSUE_STATUSES), z.array(z.enum(ISSUE_STATUSES)))
    .optional(),
});

export type StatusExits = Partial<Record<IssueStatus, IssueStatus[]>>;
export type PipelineRegistryResponse = z.infer<typeof pipelineRegistryResponseSchema>;
