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

/**
 * The attribute keys that hold at most one row per issue. The registry derives each key's
 * `cardinality` from this list and `issue_attributes` keeps the promise as a partial unique
 * index over exactly these keys, so the writer and the database cannot disagree about which
 * keys are single-row.
 */
export const singleRowAttributeKeys = [
  'obligation_owner',
  'obligation_carrier',
  'delivered',
  'delivered_of',
  'human_required',
  'irreversible_if_wrong',
  'source',
] as const;
export type SingleRowAttributeKey = (typeof singleRowAttributeKeys)[number];
