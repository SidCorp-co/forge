/**
 * What the approval of a design revision records on the issue that drew it (ISS-262): the revision is
 * that issue's deliverable, so its approval is where the work landed. The mark is written or
 * re-pointed to the approved revision in the decision's transaction, so a mark naming a proposed
 * revision does not outlive its approval. It moves no status — recording a landing never does
 * (docs/modules/issues/merge-mark.md) and only a release closes — so the issue's run or its release
 * takes the next move, on this evidence.
 */

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { Actor } from './activity.js';
import { readLandingShape, SOURCE_UNDECLARED } from './landing-evidence.js';
import {
  type MergeMarkColumns,
  type MergeMarkKind,
  mergeMarkKindOf,
  recordDesignLanding,
} from './merge-record.js';

export interface DesignLandingOutcome {
  /** `marked` over no mark, `repointed` over one somebody's word made, `kept` where the mark stands. */
  action: 'marked' | 'repointed' | 'kept' | 'none';
  /** The mark the issue carries after the approval; null where there is no issue to read. */
  mark: MergeMarkKind | null;
  /** The issue's status, which the approval does not move; null where there is no issue to read. */
  status: string | null;
  /** The landing a re-point replaced, where it named one. */
  replaced: string | null;
  /** Why nothing was written, where nothing was. */
  why: string | null;
}

/** The landing an approved design revision is: what it is and that it was approved. */
export function designLandingOf(flow: string, revision: number): string {
  return `workflow design \`${flow}\` revision ${revision}, approved`;
}

const none = (
  why: string,
  mark: MergeMarkKind | null = null,
  status: string | null = null,
): DesignLandingOutcome => ({ action: 'none', mark, status, replaced: null, why });

export async function markApprovedDesign(
  tx: Tx,
  args: { issueId: string; flow: string; revision: number; actor: Actor },
): Promise<DesignLandingOutcome> {
  const rows = (await tx.execute(sql`
    SELECT project_id, status, archived_at, merged_at, merged_commit_sha, merged_landing
      FROM issues WHERE id = ${args.issueId} FOR UPDATE
  `)) as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return none('the design issue no longer exists');
  const held: MergeMarkColumns = {
    mergedAt: (row.merged_at as string | null) ?? null,
    mergedCommitSha: (row.merged_commit_sha as string | null) ?? null,
    mergedLanding: (row.merged_landing as string | null) ?? null,
  };
  const kind = mergeMarkKindOf(held);
  const status = String(row.status);
  if (row.archived_at != null) return none('the design issue is archived', kind, status);
  if (status === 'dropped') {
    return none('the design issue was dropped, so nothing of it landed', kind, status);
  }
  const shape = await readLandingShape(String(row.project_id), tx);
  if (shape === null) return none(SOURCE_UNDECLARED, kind, status);
  const landing = shape === 'outside_git' ? designLandingOf(args.flow, args.revision) : null;
  const stamp = await recordDesignLanding(tx, {
    issueId: args.issueId,
    landing,
    actor: { type: args.actor.type, id: args.actor.id, agency: args.actor.agency },
  });
  const mark = mergeMarkKindOf({
    mergedAt: stamp.mergedAt,
    mergedCommitSha: stamp.commitSha,
    mergedLanding: stamp.landing,
  });
  if (!stamp.wrote) return { action: 'kept', mark, status, replaced: null, why: null };
  const before = mergeMarkKindOf(stamp.before);
  return {
    action: before === 'unmarked' ? 'marked' : 'repointed',
    mark,
    status,
    replaced: stamp.before.mergedLanding,
    why: null,
  };
}

/** The notice the design issue carries saying what the approval recorded on it. */
export function designLandingNotice(
  args: { flow: string; revision: number },
  outcome: DesignLandingOutcome,
): string | null {
  const design = `Design \`${args.flow}\` revision ${args.revision} was approved`;
  if (outcome.action === 'marked' || outcome.action === 'repointed') {
    const was =
      outcome.action === 'repointed'
        ? outcome.replaced
          ? ` It replaces the landing this issue was marked with before: ${outcome.replaced}.`
          : ' It replaces the mark this issue carried before, which named no landing.'
        : '';
    const names =
      outcome.mark === 'landed'
        ? 'Its landing now names the approved revision.'
        : 'This project lands its work in git, where a mark names no revision, so the mark is a timestamp and this notice names the revision.';
    return `${design}, and it is this issue's deliverable, so this issue's merged mark now records it. ${names}${was} The approval moves no status: this issue's run, or the release that claims it, takes its next move.`;
  }
  return null;
}
