/**
 * What a mark asks before its stamp, apart from the landing it names: the commit a mark records when
 * the caller named none, the merge check and review owed at that commit, and the carriers its
 * artifacts name. The mark writer (`merge-marker.ts`) calls each.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { FileChange, LandingArtifact } from '@forge/contracts/landing-artifacts';
import { refuser } from '../lib/refusal.js';
import { resolveCarriage } from './carriage.js';
import type { LandingShape } from './landing-evidence.js';
import { lastUnmarkedAt } from './mark-trail.js';
import { uncheckedMergeRefusal } from './merge-check.js';
import { markEntryRefusal } from './pattern-entry.js';
import type { IssueRow } from './read-service.js';
import { unreviewedMergeRefusal } from './review.js';
import { latestHandoffCommit } from './work-evidence.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/**
 * ISS-959 — the commit this mark records, when the caller named none.
 *
 * `forge guide contract earning-and-unearning` requires that anything the
 * repository knows is written onto the issue at the step that knew it, and
 * says of this one: *"the merged mark, which today takes no commit and carries
 * it in the prose of its note"*. Prose is not a field, so the note's form was
 * part of the contract. This is the field, and the fallback is what makes it
 * arrive without every client learning it first.
 *
 * Only the newest handoff written since the issue was last unmarked is this landing's: an unmark
 * withdrew the landing every earlier handoff named, so a mark after it never claims one (ISS-489).
 */
export async function resolveRecordedCommit(issueId: string): Promise<string | null> {
  return latestHandoffCommit(issueId, await lastUnmarkedAt(issueId));
}

/**
 * A merge a check is owed for is marked only at a commit a passing merge check is recorded at
 * (Issue to release r20 `rule-merge`; `merge-check.ts`). The commit is the one the mark names, else
 * the one the row or the issue's work evidence already records. Before that, each approved new
 * pattern's catalog page must be in the change at that commit (`pattern-entry.ts`): a check that ran
 * while the pattern waited on its reviewer did not ask for it. After it, a project that declares the
 * merge check asks a passing review at that commit by another than the building run (`review.ts`).
 */
export async function refuseUncheckedMerge(
  args: {
    commit?: string | undefined;
    changedPaths?: { commit: string; changes: FileChange[] } | undefined;
  },
  prior: IssueRow,
  shape: LandingShape,
): Promise<void> {
  if (shape !== 'git') return;
  const commit =
    args.commit ?? prior.mergedCommitSha ?? (await resolveRecordedCommit(prior.id)) ?? null;
  const entry = await markEntryRefusal({
    issueId: prior.id,
    projectId: prior.projectId,
    commit,
    changedPaths: args.changedPaths ?? null,
  });
  if (entry) throw refuse(entry.code, entry.detail, entry.path);
  const detail = await uncheckedMergeRefusal({
    issueId: prior.id,
    projectId: prior.projectId,
    commit,
  });
  if (detail) throw refuse('MERGE_CHECK_MISSING', detail, '/commit');
  const review = await unreviewedMergeRefusal({
    issueId: prior.id,
    projectId: prior.projectId,
    commit,
  });
  if (review) throw refuse('MERGE_REVIEW_MISSING', review, '/commit');
}

/** The mark's artifacts with each `carriedBy` resolved to its carrier's key, or the refusal naming it. */
export async function withCarriers<
  A extends { op: 'mark' | 'unmark'; artifacts?: readonly LandingArtifact[] | undefined },
>(args: A, prior: IssueRow): Promise<A> {
  if (args.op !== 'mark' || !args.artifacts?.some((a) => a.carriedBy !== undefined)) return args;
  const carried = await resolveCarriage({
    issueId: prior.id,
    projectId: prior.projectId,
    artifacts: args.artifacts,
  });
  if (!carried.ok) {
    throw refuse(carried.code, carried.detail, `/artifacts/${carried.index}/carriedBy`);
  }
  return { ...args, artifacts: carried.artifacts };
}
