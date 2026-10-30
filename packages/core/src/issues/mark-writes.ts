/**
 * The two writes a merge mark makes beside its stamp (`merge-marker.ts:applyMergeMarker`): the box's
 * reading of the landing commit's paths, and an unmark's clear of the row.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { Tx } from '../db/client.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import type { Actor } from './activity.js';
import { CLEAR_THE_MARK, type markReadPaths } from './landing-evidence.js';
import { clearIssueMerge, recordReadPaths } from './merge-record.js';
import { refuseUnmarkOnClosed } from './merged-at.js';
import { findIssueById } from './read-service.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

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
