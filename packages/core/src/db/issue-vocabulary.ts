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

export const waitingKinds = ['needs_decision', 'needs_resource'] as const;
export type WaitingKind = (typeof waitingKinds)[number];

export const issueStatuses = [
  'open',
  'confirmed',
  'clarified',
  'waiting',
  'approved',
  'in_progress',
  'developed',
  'testing',
  'tested',
  'awaiting_release',
  'releasing',
  'closed',
  'reopen',
  'on_hold',
  'needs_info',
  'draft',
  'dropped',
] as const;
export type IssueStatus = (typeof issueStatuses)[number];

export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const issueDependencyKinds = [
  'blocks',
  'relates',
  'duplicates',
  'parent',
  'decomposes',
] as const;
export type IssueDependencyKind = (typeof issueDependencyKinds)[number];

export const issueDependencyHolds = ['settled', 'shipped'] as const;
export type IssueDependencyHold = (typeof issueDependencyHolds)[number];
