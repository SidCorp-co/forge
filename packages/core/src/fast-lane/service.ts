// The fast lane's reads (REQ-39 BC-7, BC-8): the project's declaration, the issue's approved preview,
// and the rule each answer goes through (`rules.ts`). The merge check asks `fastLaneMergeRefusal`
// through the issue kernel's port; `GET /api/issues/:id/lane` answers `issueLane`.

import type { FastLaneSettings } from '@forge/contracts/fast-lane';
import type { MergeCheckReport } from '@forge/contracts/merge-check';
import { issueDisplayIds } from '../issues/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { readApprovedPreview } from './ports.js';
import { type FastLaneRefusal, fastMergeRefusal, type IssueLane, issueLaneOf } from './rules.js';

/** The project's `fastLane` declaration, or null where it declares none: every change is full lane. */
export async function fastLaneSettingsOf(projectId: string): Promise<FastLaneSettings | null> {
  return (await readProjectDocument(projectId))?.document.fastLane ?? null;
}

async function issueRefOf(issueId: string): Promise<string> {
  return (await issueDisplayIds([issueId])).get(issueId) ?? issueId;
}

/** Why a fast-lane merge check may not stand for this issue, or null. */
export async function fastLaneMergeRefusal(args: {
  issueId: string;
  projectId: string;
  report: MergeCheckReport;
}): Promise<FastLaneRefusal | null> {
  const [settings, approval, issueRef] = await Promise.all([
    fastLaneSettingsOf(args.projectId),
    readApprovedPreview(args.issueId),
    issueRefOf(args.issueId),
  ]);
  return fastMergeRefusal({ issueRef, report: args.report, settings, approval });
}

/** The lane the issue's approved change takes, and why it is not the fast one where it is not. */
export async function issueLane(issue: {
  id: string;
  projectId: string;
}): Promise<IssueLane & { issueId: string }> {
  const [settings, approval, issueRef] = await Promise.all([
    fastLaneSettingsOf(issue.projectId),
    readApprovedPreview(issue.id),
    issueRefOf(issue.id),
  ]);
  return { issueId: issue.id, ...issueLaneOf({ issueRef, settings, approval }) };
}
