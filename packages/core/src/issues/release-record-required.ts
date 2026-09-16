// An agent may finish an issue. It may not claim a ship with nothing written.
//
// `closed` is what every reader takes as shipped — the L2 blocks gate, the
// release roster, pipeline health, and `markMergedOnClose`, which stamps
// `merged_at` on the way past. Nothing asked whether a line had been written,
// so ISS-868, ISS-718, ISS-846 and ISS-847 closed on 2026-08-27 with no
// changelog entry. ISS-830 and ISS-810 closed with `releaseNotes` null.
//
// Two doors reach `closed` with an automated hand on them, so the rule stands
// at both: `refuseUnrecordedClose` on the transition, and
// `issuesMissingReleaseRecord` at the release batch's CLAIM, before anything
// has moved — the batch's own close carries `viaReleasePath` and is exempt.
//
// What it guarantees, exactly: a release note EXISTS ON THE ISSUE before an
// automated close. NOT that a line reached `CHANGELOG.md` — that is a git
// artifact core never reads, held separately by check-release-record.mjs.
//
// It strands nobody: one `forge_issues.update { releaseNotes }` clears it, and
// `section: 'Skip'` is the honest answer for an internal change.

import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { type ActorAgency, actorAgency } from './actor-agency.js';

export interface ReleaseRecordRefusal {
  detail: string;
  details: Record<string, unknown>;
}

export const RELEASE_RECORD_REMEDY =
  'Set `releaseNotes` first: `{ section, userFacing }` with the one plain-language line a ' +
  "user would read, or `{ section: 'Skip', userFacing: '-' }` when the change has no " +
  'user-facing half.';

/**
 * Which of these issues have no release note. The shared read behind both doors.
 */
export async function issuesMissingReleaseRecord(issueIds: string[]): Promise<string[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({ id: issues.id, releaseNotes: issues.releaseNotes })
    .from(issues)
    .where(inArray(issues.id, issueIds))
    .limit(issueIds.length);
  return rows.filter((r) => !r.releaseNotes).map((r) => r.id);
}

export async function refuseUnrecordedClose(
  issueId: string,
  toStatus: IssueStatus,
  actor: { type: 'user' | 'device'; agency?: ActorAgency | null },
  options: { viaReleasePath?: boolean },
): Promise<ReleaseRecordRefusal | null> {
  if (toStatus !== 'closed') return null;
  if (actorAgency(actor) !== 'agent') return null;
  if (options.viaReleasePath === true) return null;

  const missing = await issuesMissingReleaseRecord([issueId]);
  if (missing.length === 0) return null;

  return {
    detail:
      '`closed` is what every reader takes as "this shipped", so an issue cannot close with ' +
      `nothing written about what shipped. ${RELEASE_RECORD_REMEDY} ` +
      'Use `dropped` instead if this turned out not to be work — that closes it without the claim.',
    details: { requires: 'releaseNotes' },
  };
}
