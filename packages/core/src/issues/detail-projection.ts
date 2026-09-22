/**
 * The REST issue-detail row, as the four routes that return a whole issue serialize it.
 *
 * The sibling of `list-projection.ts`: that one owns the row the two list routes return, this one
 * owns the row `GET /:id`, `POST /`, `PATCH /:id` and the by-display route return. Both were in
 * `routes.ts` and only one of them had been moved out.
 *
 * ISS-1126 — `mergeMark` is `merge-record.ts`'s reading of the pair of columns and never the
 * client's. The detail response has carried `merged_commit_sha` since ISS-959 and nothing read it,
 * because what the pair MEANS was written down nowhere; a browser deciding for itself that an
 * empty sha means a claim would be a second authority on a question the module that writes those
 * columns already answers.
 */

import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type MergeMarkColumns, type MergeMarkKind, mergeMarkKindOf } from './merge-record.js';

export interface IssueBodyColumns {
  description?: string | null;
  descriptionFormat?: string | null;
}

export function serializeIssue<T extends { issSeq: number } & IssueBodyColumns & MergeMarkColumns>(
  row: T,
  prefix: string | null,
): T & { displayId: string; descriptionNodes: BodyNode[] | null; mergeMark: MergeMarkKind } {
  return {
    ...row,
    displayId: formatIssueRef(prefix, row.issSeq),
    descriptionNodes: bodyNodes(row.description ?? '', row.descriptionFormat),
    mergeMark: mergeMarkKindOf(row),
  };
}
