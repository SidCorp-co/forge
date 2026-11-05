/**
 * The correction door for a closed issue's false observed mark (ISS-1027, adminhub-api FB-528).
 *
 * MR 5162's merge stamped adminhub-api ISS-2, closed long before, with 6a40f293 over its real landing
 * b87cbba2. The ordinary doors cannot undo that on a closed issue: an unmark answers
 * UNMARK_REQUIRES_NOT_CLOSED (`closed` means shipped, and clearing the mark would leave it shipping
 * nothing), and a re-mark answers already_merged, keeping the wrong commit and the right one only as a
 * claim. Reopening a shipped issue to repair its record would move a status nothing about the work
 * changed. So a closed issue's landing commit is replaced here, in place: the status never moves, the
 * mark stays standing, and the correction is written on the issue's history with who made it, the
 * commit it replaced, the commit it names, the reason and what misread it. Nothing is erased.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import type { OutboxActor } from '@forge/contracts/outbox-events';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import { insertActivityRow } from './activity-log.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The activity a correction writes on the issue whose mark it replaced. */
export const MERGE_CORRECTED = 'issue.mergeCorrected';

/** A whole git sha, SHA-1 or SHA-256: an observed mark records nothing shorter. */
const WHOLE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The body as the route parsed it: `commit` and `reason` are checked here, so each is refused by name. */
export interface MergeCorrectionInput {
  commit?: string | undefined;
  reason?: string | undefined;
  misread?: string | undefined;
  mergedAt?: Date | undefined;
}

interface ValidCorrection {
  commit: string;
  reason: string;
  misread: string | null;
  mergedAt: Date | null;
}

/** The correction as it is written, or the refusal naming the field that is wrong and the shape that is right. */
function validCorrection(input: MergeCorrectionInput): ValidCorrection {
  const reason = input.reason?.trim() ?? '';
  if (reason === '') {
    throw refuse(
      'CORRECTION_REASON_MISSING',
      'a correction replaces the commit a shipped issue records, so it says why: send `reason`, a sentence naming what was wrong with the mark it replaces',
      '/reason',
    );
  }
  const commit = input.commit?.trim().toLowerCase() ?? '';
  if (!WHOLE_SHA.test(commit)) {
    throw refuse(
      'COMMIT_NOT_WHOLE',
      `a correction names the issue's real landing as a whole git sha, 40 hex characters (or 64), and \`commit\` is ${input.commit === undefined ? 'missing' : JSON.stringify(input.commit)}`,
      '/commit',
    );
  }
  return {
    commit,
    reason,
    misread: input.misread?.trim() || null,
    mergedAt: input.mergedAt ?? null,
  };
}

/**
 * Replace a closed issue's landing commit with the one that really landed it, and record the
 * correction on its history. The issue's status is never read as anything but the gate and never
 * written. Refused by name: an issue that is not `closed`, a commit that is not a whole sha, a
 * correction with no reason, and one naming the commit the mark already holds.
 */
export async function correctClosedMerge(args: {
  issueId: string;
  input: MergeCorrectionInput;
  actor: OutboxActor;
}): Promise<{
  id: string;
  status: string;
  corrected: { from: string | null; to: string; mergedAt: string };
  reason: string;
  misread: string | null;
}> {
  const valid = validCorrection(args.input);
  return db.transaction(async (tx) => {
    const [prior] = await tx
      .select({
        projectId: issues.projectId,
        status: issues.status,
        mergedAt: issues.mergedAt,
        mergedCommitSha: issues.mergedCommitSha,
        mergedTarget: issues.mergedTarget,
        mergedHead: issues.mergedHead,
      })
      .from(issues)
      .where(eq(issues.id, args.issueId))
      .for('update')
      .limit(1);
    if (!prior) throw notFound('issue not found');
    if (prior.status !== 'closed') {
      throw refuse(
        'CORRECTION_REQUIRES_CLOSED',
        `this issue is \`${prior.status}\`, not \`closed\`: a correction is for a shipped issue's record, which the ordinary doors cannot change. Here, unmark it (DELETE /api/issues/:id/merge) and mark it again naming the commit that landed it (POST /api/issues/:id/merge)`,
      );
    }
    const from = prior.mergedCommitSha?.toLowerCase() ?? null;
    if (from === valid.commit) {
      throw refuse(
        'MARK_ALREADY_STANDS',
        `this issue's mark already records ${valid.commit}, so there is nothing to correct and nothing changed`,
        '/commit',
      );
    }
    const [wrote] = await tx
      .update(issues)
      .set({
        mergedCommitSha: valid.commit,
        // the head described the request whose merge was misread as this issue's, not its landing
        mergedHead: null,
        ...(valid.mergedAt ? { mergedAt: sqlTimestamp(valid.mergedAt) } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(issues.id, args.issueId))
      .returning({ mergedAt: issues.mergedAt });
    const mergedAt = (wrote?.mergedAt ?? prior.mergedAt) as Date;
    const before = {
      mergedCommitSha: prior.mergedCommitSha,
      mergedAt: prior.mergedAt,
      mergedHead: prior.mergedHead,
    };
    await emitEvent(tx, 'issue.updated', {
      issueId: args.issueId,
      projectId: prior.projectId,
      actor: args.actor,
      fields: ['mergedCommitSha', 'mergedAt', 'mergedHead'],
      via: 'correction',
      before,
      after: { mergedCommitSha: valid.commit, mergedAt, mergedHead: null },
    });
    await insertActivityRow(
      {
        issueId: args.issueId,
        actorType: args.actor.type,
        actorId: args.actor.id,
        actorAgency: args.actor.agency,
        action: MERGE_CORRECTED,
        payload: {
          from: {
            commitSha: prior.mergedCommitSha,
            mergedAt: prior.mergedAt,
            head: prior.mergedHead,
          },
          to: { commitSha: valid.commit, mergedAt },
          target: prior.mergedTarget,
          reason: valid.reason,
          misread: valid.misread,
        },
      },
      tx,
    );
    return {
      id: args.issueId,
      status: prior.status,
      corrected: { from, to: valid.commit, mergedAt: new Date(mergedAt).toISOString() },
      reason: valid.reason,
      misread: valid.misread,
    };
  });
}
