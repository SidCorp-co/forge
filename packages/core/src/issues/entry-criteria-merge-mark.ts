/**
 * ISS-1126 — which kinds of merged mark the `merged_mark` entry criterion accepts as landed.
 *
 * `merged_at` carries two different records under one column. One is a merge Forge observed and has
 * its own commit for; the other is somebody's claim that work shipped. ISS-1126's rule is that a
 * reader meaning *shipped* states which of them satisfies it — either answer is defensible, being
 * unable to tell which one is in force is not.
 *
 * THE ANSWER IN FORCE, AND ITS PRICE. This criterion accepts an asserted mark. That is an amnesty
 * and it is priced here rather than in a comment somewhere else: on this database 851 of 851 marks
 * are asserted, because `observedMergeForIssue` needs a `repo_pull_requests` row in state `merged`
 * and until ISS-1123 (`9a78b0c93`) nothing but an inbound webhook could write one, and no inbound
 * delivery has ever been recorded on this project's binding. Refusing asserted marks today would
 * fail this criterion on every issue the project has and stop every run.
 *
 * WHAT ENDS IT. When observed marks are being written here — a pull request opened through Forge
 * and merged through the kernel door leaves a row and stamps the commit — this set narrows to
 * `['observed']` and the amnesty is over. Narrowing it is the whole change: the criterion is gated
 * on membership of this constant, so nothing else has to move.
 */

import {
  describeMergeMark,
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
} from './merge-record.js';

export const MARKS_ACCEPTED_AS_LANDED: readonly MergeMarkKind[] = ['asserted', 'observed'];

/**
 * Why this issue's mark does not satisfy `merged_mark`, or null when it does.
 *
 * The refusal names the kinds that WOULD have satisfied it, so a caller told no is told what to do
 * rather than left to read this file.
 */
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
