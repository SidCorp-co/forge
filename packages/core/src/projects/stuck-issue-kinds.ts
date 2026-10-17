import type { StuckIssueKind } from '@forge/contracts/notifications';
import type { StuckKind } from '@forge/contracts/stuck-words';
import { type SQL, sql } from 'drizzle-orm';

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
// The words' kinds, restated where they are built, compile only while they are these kinds too.
const wordedKinds: readonly StuckKind[] = [] as StuckIssueKind[];
const kindsWorded: readonly StuckIssueKind[] = [] as StuckKind[];
void wordedKinds;
void kindsWorded;

/** Whether a stuck-issue notice stands for this issue: what the stuck count and filter both read. */
export function stuckNoticeStandsSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM notifications sn
     WHERE sn.issue_id = ${issueId}
       AND sn.type = 'issue_stranded'
       AND sn.state = 'firing'
       AND sn.resolved_at IS NULL
  )`;
}
