/** The REST issue-detail row, sibling of `list-projection.ts`; `mergeMark` is
 *  `merge-record.ts`'s reading of the pair and never the client's: docs/modules/issues/merge-mark.md. */

import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { LandingShape } from './landing-evidence.js';
import { type MergeMarkColumns, type MergeMarkKind, mergeMarkKindOf } from './merge-record.js';

export interface IssueBodyColumns {
  description?: string | null;
  descriptionFormat?: string | null;
}

/** `landingShape` is `landing-evidence.ts`'s answer for the issue's project, so a client offering
 *  a mark asks for what this project's close will accept rather than re-deriving it from `kind`. */
export function serializeIssue<T extends { issSeq: number } & IssueBodyColumns & MergeMarkColumns>(
  row: T,
  prefix: string | null,
  landingShape: LandingShape,
): T & {
  displayId: string;
  descriptionNodes: BodyNode[] | null;
  mergeMark: MergeMarkKind;
  landingShape: LandingShape;
} {
  return {
    ...row,
    displayId: formatIssueRef(prefix, row.issSeq),
    descriptionNodes: bodyNodes(row.description ?? '', row.descriptionFormat),
    mergeMark: mergeMarkKindOf(row),
    landingShape,
  };
}
