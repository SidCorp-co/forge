/**
 * The writes a merge mark makes beside its stamp (`merge-marker.ts:applyMergeMarker`): the stamp of a
 * commit the repository holds as the issue's, the box's reading of the landing commit's paths, and an
 * unmark's clear of the row.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { LandingArtifact } from '@forge/contracts/landing-artifacts';
import type { Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import type { Actor } from './activity.js';
import type { CommitLanding } from './commit-landing.js';
import { CLEAR_THE_MARK, type markReadPaths, standingObservedRefusal } from './landing-evidence.js';
import type { AmendedAsserted } from './mark-detail.js';
import { currentMarkClaims } from './mark-trail.js';
import { recordReadPaths } from './merge-paths.js';
import { clearIssueMerge, type MergeRecord, recordIssueMerge } from './merge-record.js';
import { refuseUnmarkOnClosed } from './merged-at.js';
import { findIssueById } from './read-service.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/**
 * A commit the repository holds as this issue's, stamped as observed: it amends a standing asserted
 * mark in place and says what it wrote over (ISS-1445), and is refused by name over a merge observed
 * at another commit, which is never written over.
 */
export async function stampRepositoryCommit(
  tx: Tx,
  args: {
    issueId: string;
    actor: Actor;
    commit: Extract<CommitLanding, { ok: true }>;
    landing: string | null;
    artifacts: LandingArtifact[] | null;
  },
): Promise<{ result: MergeRecord; amendedAsserted: AmendedAsserted | null }> {
  const { issueId, commit } = args;
  const result = await recordIssueMerge(tx, {
    issueId,
    via: 'repository',
    actor: args.actor,
    evidence: {
      kind: 'observed',
      commitSha: commit.sha,
      mergedAt: commit.committedAt,
      target: commit.branch,
      landing: args.landing,
      artifacts: args.artifacts,
    },
    amendsAsserted: true,
  });
  const overObserved = standingObservedRefusal({ named: commit, result });
  if (overObserved) throw refuse(overObserved.code, overObserved.detail, '/commit');
  if (!result.amended) return { result, amendedAsserted: null };
  // the claim the amended mark made: its trail record, the newest until this mark writes its own
  const claimed = (await currentMarkClaims([issueId], tx)).get(issueId) ?? null;
  return { result, amendedAsserted: { ...result.amended, claimed } };
}

/** The box's reading of the landing commit, or the refusal where the row already holds another's. */
export async function recordStampPaths(
  tx: Tx,
  issueId: string,
  paths: NonNullable<Extract<ReturnType<typeof markReadPaths>, { ok: true }>['paths']>,
  actor: Actor,
): Promise<void> {
  const { wrote, held } = await recordReadPaths(tx, { issueId, paths, actor });
  if (wrote || !held || held.commit.toLowerCase() === paths.commit.toLowerCase()) return;
  throw refuse(
    'MARK_ALREADY_STANDS',
    `this issue's mark already holds the paths read at ${held.commit}, and the first reading stands, so the paths read at ${paths.commit} were not recorded and nothing changed. To change them, ${CLEAR_THE_MARK}, then mark again naming the commit that landed.`,
    '/changedPaths',
  );
}

/**
 * The `closed` guard is the UPDATE's own WHERE, so nothing can close the row between the decision
 * and the write. A zero-row answer is read back rather than guessed at: the row is gone, or it is
 * closed, and anything else is a state those two conditions cannot produce.
 */
export async function clearMark(tx: Tx, issueId: string): Promise<void> {
  if (await clearIssueMerge(tx, issueId)) return;
  const still = await findIssueById(issueId);
  if (!still) throw notFound('issue not found');
  const refusal = refuseUnmarkOnClosed(still.status);
  if (!refusal) {
    throw new Error(
      `unmark cleared no row on issue ${issueId}, which is neither missing nor \`closed\` but ` +
        `\`${still.status}\`. The UPDATE's only other condition is the id, so this is a state ` +
        `clearIssueMerge cannot produce and must not be reported as either of them.`,
    );
  }
  throw refuse('UNMARK_REQUIRES_NOT_CLOSED', refusal.detail);
}
