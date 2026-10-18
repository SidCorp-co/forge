import type { StuckIssueKind } from '@forge/contracts/notifications';
import type { StuckKind } from '@forge/contracts/stuck-words';
import { type SQL, sql } from 'drizzle-orm';

export const STUCK_ISSUE_KINDS = [
  'waiting',
  'waiting_on_others',
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

/** Each sweep's resolution-key suffix and the kind it tells, most specific first (ISS-1229 r14). */
export const STUCK_NOTICES = [
  { suffix: ':stranded', kind: 'waiting' },
  { suffix: ':owed-close', kind: 'owed_close' },
  { suffix: ':run-assertion-orphaned', kind: 'orphan' },
  { suffix: ':idle', kind: 'idle' },
] as const satisfies readonly { suffix: string; kind: StuckIssueKind }[];

function byNotice(key: SQL, said: (i: number) => SQL, otherwise: SQL): SQL {
  const whens = STUCK_NOTICES.map(
    (n, i) => sql`WHEN ${key} LIKE ${`%${n.suffix}`} THEN ${said(i)}`,
  );
  return sql`(CASE ${sql.join(whens, sql` `)} ELSE ${otherwise} END)`;
}

/** The kind a notice's resolution key tells. */
export function stuckKindSql(key: SQL): SQL {
  return byNotice(key, (i) => sql.raw(`'${STUCK_NOTICES[i]?.kind}'`), sql.raw(`'other'`));
}

/** Who owes an issue's park: its assignee, else whoever filed it (`ownedForAnswer`). */
export function parkOwerSql(issueId: SQL): SQL {
  return sql`(SELECT coalesce(po.assignee_id, po.created_by_id) FROM issues po WHERE po.id = ${issueId})`;
}

export function parkOwerNameSql(issueId: SQL): SQL {
  return sql`(SELECT coalesce(pu.display_name, pu.email) FROM users pu WHERE pu.id = ${parkOwerSql(issueId)})`;
}

/** The kind a notice tells this reader by: a waiting park somebody else owes is never theirs. */
export function readerStuckKindSql(key: SQL, issueId: SQL, readerId: string): SQL {
  return sql`(CASE WHEN ${stuckKindSql(key)} = 'waiting'
                    AND ${parkOwerSql(issueId)} IS DISTINCT FROM ${readerId}::uuid
                   THEN 'waiting_on_others' ELSE ${stuckKindSql(key)} END)`;
}

/** Where a notice's reason stands among the others, most specific lowest. */
export function stuckRankSql(key: SQL): SQL {
  return byNotice(key, (i) => sql.raw(String(i)), sql.raw(String(STUCK_NOTICES.length)));
}

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
