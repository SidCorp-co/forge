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

// cm:guard the exemptions are the WHOLE rule and there is no fourth. `actor.type === 'device'` keeps a human's close working — an operator closing by hand makes the shipped claim deliberately and owns it, the same carve-out release-gate-hold.ts states for the sibling rule. `viaReleasePath` is exempt ONLY because createReleaseBatch now refuses to CLAIM an issue with no note (release-batch/service.ts), so by the time finishReleaseBatch closes it the note is already there; delete that preflight and this exemption becomes the hole it used to be.
// cm:edge lockstep -> packages/core/src/release-batch/service.ts — `viaReleasePath` is exempt here BECAUSE the claim preflight there refuses a note-less issue. The two are one rule with two doors; removing either one silently reopens ISS-863's measured path.
// cm:guard do NOT re-add a `merged_at IS NULL` condition to bound the blast radius. It was tried and the integration suite falsified it: mergeStates.baseBranch defaults to `released`, so the canonical staged close IS the hop out of the base state, markMergedIfLeavingBase stamps INSIDE the transaction this check runs before, and the column reads NULL for exactly the path the condition was meant to exempt.
// cm:guard exempt `viaCloseCascade`, NEVER the shared `skip` flag. `skip` was tried and is far wider than the decompose cascade it was justified with: resolveSkipTarget('released', {}, hasSkill:()=>false) answers `closed` (STAGE_FORWARD.released, and `closed` anchors because it is not in SKIPPABLE_STAGES), so orchestrator.ts's auto-skip chain would auto-close with nothing written on any project whose `released` stage has no registered skill — the default for a fresh one. That chain catches the refusal and stops, leaving the issue at `released`, which is the honest state.
// cm:why the actor and options params are structural rather than the imported `Actor` / `ApplyStatusTransitionOptions` — apply-transition.ts imports THIS module, so naming its types here would close a module cycle for no gain
export async function refuseUnrecordedClose(
  issueId: string,
  toStatus: IssueStatus,
  actor: { type: 'user' | 'device' },
  options: { viaReleasePath?: boolean; viaCloseCascade?: boolean },
): Promise<ReleaseRecordRefusal | null> {
  if (toStatus !== 'closed') return null;
  if (actor.type !== 'device') return null;
  if (options.viaReleasePath === true) return null;
  if (options.viaCloseCascade === true) return null;

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
