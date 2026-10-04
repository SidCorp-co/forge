// Response schema for `GET /api/pipeline/registry`. The runtime literal +
// derived constants live in `@forge/core/src/pipeline/registry.ts`; this
// file is the client-facing Zod contract.
//
// The issue statuses are the issue machine's (`issue-machine.ts`).
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
export const REGISTRY_ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

export const REGISTRY_ISSUE_COMPLEXITIES = ['xs', 's', 'm', 'l', 'xl'] as const;

export const REGISTRY_PIPELINE_RUN_KINDS = ['issue', 'pm', 'interactive', 'system'] as const;
