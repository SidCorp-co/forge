// What waits for a release (ISS-1062): every issue at `awaiting_release`, and every issue its holder
// closed met in scope from there, its merge recorded, that no shipped release holds yet. `closed`
// says the criteria were met in scope, never that the work is live, so a release carries such an
// issue as it carries one at the gate: the roster it claims, the draft, the sweep and the record door
// all read this one predicate. A release over a closed issue moves no status; it records the release,
// and `releasedSql` then reads the issue as released.
//
// Only a close on the machine that has the holder's close counts (`IN_SCOPE_CLOSE_SINCE`): a row
// closed under the release-only rule keeps what it holds and joins no roster. A design-only or
// adoption-only close ships nothing a release carries, so it waits for none.

import { ISSUE_MACHINE } from '@forge/contracts/issue-machine';
import { type SQL, sql } from 'drizzle-orm';
import { designOnlyMarkSql } from './design-delivery.js';
import { releasedSql } from './release-evidence.js';

/** The shape of the issue machine on which the holder's close (`met.in.scope`) was first declared. */
const IN_SCOPE_SHAPE = 'a7a32987';

/** The first machine version whose close from `awaiting_release` may be the holder's, not a release's. */
export const IN_SCOPE_CLOSE_SINCE = (() => {
  const at = ISSUE_MACHINE.shapes.indexOf(IN_SCOPE_SHAPE);
  if (at < 0) {
    throw new Error(
      `the issue machine records no shape ${IN_SCOPE_SHAPE}, the one that declared the holder's close: whatever replaced it says from which version a closed issue may still wait for a release`,
    );
  }
  return at + 1;
})();

/**
 * The issue row aliased `i` carries an adoption record alone (REQ-5 BC-17), as
 * `merge-mark-kind.ts:adoptionOnlyStamp` reads it: no commit, no read paths, and every artifact an
 * `adoption` one. Never NULL.
 */
export function adoptionOnlyMarkSql(i: SQL): SQL {
  return sql`coalesce((${i}.merged_at IS NOT NULL
    AND coalesce(trim(${i}.merged_commit_sha), '') = ''
    AND ${i}.merged_paths IS NULL
    AND jsonb_typeof(${i}.merged_artifacts) = 'array'
    AND jsonb_array_length(${i}.merged_artifacts) > 0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${i}.merged_artifacts) aa
                     WHERE aa->>'surface' IS DISTINCT FROM 'adoption')), false)`;
}

/**
 * The issue row aliased `i` is `closed` met in scope by its holder and no shipped release holds its
 * work yet: its merge recorded, its newest close the `awaiting_release` edge on a machine that has
 * the holder's close, not design-only or adoption-only, and not `releasedSql`. Never NULL.
 */
export function closedUnreleasedSql(i: SQL): SQL {
  return sql`(${i}.status = 'closed'
    AND ${i}.merged_at IS NOT NULL
    AND NOT ${designOnlyMarkSql(i)}
    AND NOT ${adoptionOnlyMarkSql(i)}
    AND coalesce((
      SELECT c.from_status = 'awaiting_release' AND coalesce(c.machine_version, 0) >= ${IN_SCOPE_CLOSE_SINCE}
        FROM kernel_transitions c
       WHERE c.entity = 'issue' AND c.entity_id = ${i}.id AND c.to_status = 'closed'
       ORDER BY c.created_at DESC, c.id DESC LIMIT 1), false)
    AND NOT ${releasedSql(sql`${i}.id`, sql`${i}.project_id`)})`;
}

/**
 * The issue row aliased `i` waits for a release: at `awaiting_release`, or `closedUnreleasedSql`.
 * Claimed or not: a reader asking for the unclaimed roster adds `release_batch_run_id IS NULL`.
 */
export function waitingForReleaseSql(i: SQL): SQL {
  return sql`(${i}.status = 'awaiting_release' OR ${closedUnreleasedSql(i)})`;
}

/**
 * Where a claim at `gateStatus` reads its rows: the release gate and `closed` are both the roster
 * (`waitingForReleaseSql`); any other status (a draft filed for an owed merge) is that status alone.
 */
export function waitingAtSql(i: SQL, gateStatus: string): SQL {
  return gateStatus === 'awaiting_release' || gateStatus === 'closed'
    ? waitingForReleaseSql(i)
    : sql`${i}.status = ${gateStatus}`;
}
