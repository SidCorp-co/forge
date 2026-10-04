// The job, priority, complexity and run-kind vocabularies the contracts' Zod schemas
// enumerate.

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
  'smoke',
  'release_batch',
  'drive',
  'onboarding',
] as const;

export const REGISTRY_ISSUE_PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

export const REGISTRY_ISSUE_COMPLEXITIES = ['xs', 's', 'm', 'l', 'xl'] as const;

export const REGISTRY_PIPELINE_RUN_KINDS = ['issue', 'interactive', 'system'] as const;
