/** Which kinds of mark `merged_mark` accepts; the amnesty and its price: docs/modules/issues/merge-mark.md. */

import {
  describeMergeMark,
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-record.js';

export const MARKS_ACCEPTED_AS_LANDED: readonly MergeMarkKind[] = ['asserted', 'observed'];

/** Why this issue's mark fails `merged_mark`, or null; the refusal names what would pass. */
export function mergedMarkShortfall(
  row: MergeMarkColumns,
  accepted: readonly MergeMarkKind[] = MARKS_ACCEPTED_AS_LANDED,
): string | null {
  const kind = mergeMarkKindOf(row);
  if (accepted.includes(kind)) return null;
  const wanted = accepted.map((k) => `\`${k}\``).join(' or ');
  return (
    `${describeMergeMark({ kind, commitSha: row.mergedCommitSha })}, and this status accepts ` +
    `${wanted} — mark it merged, naming the commit it landed at, before this status`
  );
}
