import type { StuckIssueKind } from '@forge/contracts/notifications';

export const STUCK_ISSUE_KINDS = [
  'waiting',
  'idle',
  'owed_close',
  'orphan',
  'other',
] as const satisfies readonly StuckIssueKind[];

// The contracts' kinds as values (core loads no `src` contracts subpath at runtime); compiles only while both agree.
const everyKind: readonly (typeof STUCK_ISSUE_KINDS)[number][] = [] as StuckIssueKind[];
void everyKind;
