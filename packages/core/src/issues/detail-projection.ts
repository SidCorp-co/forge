/** The REST issue-detail row, sibling of `list-projection.ts`; `mergeMark` is
 *  `merge-record.ts`'s reading of the pair and never the client's: docs/modules/issues/merge-mark.md. */

import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type LandingShape, laneFrom } from './landing-evidence.js';
import { type MergeMarkColumns, type MergeMarkKind, mergeMarkKindOf } from './merge-record.js';

export interface IssueBodyColumns {
  description?: string | null;
  descriptionFormat?: string | null;
}

/** `landingShape` is the issue's lane (`landing-evidence.ts`): its declaration, else `projectShape`,
 *  so a client reads one field for what its close accepts and never combines two. */
export function serializeIssue<
  T extends { issSeq: number; declaredLandingShape: LandingShape | null } & IssueBodyColumns &
    MergeMarkColumns,
>(
  row: T,
  prefix: string | null,
  projectShape: LandingShape,
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
    landingShape: laneFrom(row.declaredLandingShape, () => projectShape).shape,
  };
}
