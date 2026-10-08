export const issuePriorities = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type IssuePriority = (typeof issuePriorities)[number];

// T-shirt sizing, mirrored by `issues_complexity_chk`; NULL is not yet sized.
export const issueComplexities = ['xs', 's', 'm', 'l', 'xl'] as const;
export type IssueComplexity = (typeof issueComplexities)[number];

// Mirrored by `issues_created_via_chk`; `web` is a session JWT only, `pat` and `device` are tokens.
export const issueCreationChannels = [
  'web',
  'mcp',
  'pipeline',
  'schedule',
  'system',
  'pat',
  'device',
] as const;
export type IssueCreationChannel = (typeof issueCreationChannels)[number];
