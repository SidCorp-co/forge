// An agent may finish an issue. It may not claim a ship with nothing written.
//
// `closed` is what every reader takes as shipped — the L2 blocks gate, the
// release roster, pipeline health, and `markMergedOnClose`, which stamps
// `merged_at` on the way past. Nothing asked whether a line had been written,
// so ISS-868, ISS-718, ISS-846 and ISS-847 closed on 2026-08-27 with no
// changelog entry, and a sweep found them days later. ISS-830 and ISS-810
// closed with `releaseNotes` null outright, so there was nothing to copy.
//
// So the close that would make the claim is refused until the record exists.
// It strands nobody: one `forge_issues.update { releaseNotes }` clears it, and
// `section: 'Skip'` is the honest answer for an internal change. What is
// refused is silence, not a decision to ship without a bullet.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';

export interface ReleaseRecordRefusal {
  detail: string;
  details: Record<string, unknown>;
}

// cm:guard the three exemptions are the WHOLE rule and there is no fourth. `actorType === 'device'` keeps a human's close working — an operator closing by hand makes the shipped claim deliberately and owns it, the same carve-out release-gate-hold.ts states for the sibling rule. `viaReleasePath` is exempt because finishReleaseBatch refuses to close anything until verifyDeployed says the release happened.
// cm:guard do NOT re-add a `merged_at IS NULL` condition to bound the blast radius. It was tried and the integration suite falsified it: mergeStates.baseBranch defaults to `released`, so the canonical staged close IS the hop out of the base state, markMergedIfLeavingBase stamps INSIDE the transaction this check runs before, and the column reads NULL for exactly the path the condition was meant to exempt.
// cm:guard `skip` is exempt for the same reason the two refusals above this one in transitionIssueStatus exempt it: those are system chains, not an agent's claim. The decompose close cascade closes a parent's children with a device actor AND swallows the error (decomposition-subscribers.ts logs and moves on), so refusing there would not surface as a failure — it would leave the children open and say nothing, which is the shape this rule exists to remove.
export async function refuseUnrecordedClose(args: {
  issueId: string;
  toStatus: IssueStatus;
  actorType: 'user' | 'device';
  viaReleasePath: boolean;
  skip: boolean;
}): Promise<ReleaseRecordRefusal | null> {
  if (args.toStatus !== 'closed') return null;
  if (args.actorType !== 'device') return null;
  if (args.viaReleasePath) return null;
  if (args.skip) return null;

  const [row] = await db
    .select({ releaseNotes: issues.releaseNotes })
    .from(issues)
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row) return null;
  if (row.releaseNotes) return null;

  return {
    detail:
      '`closed` is what every reader takes as "this shipped", so an issue cannot close with ' +
      'nothing written about what shipped. Set `releaseNotes` first: ' +
      '`{ section, userFacing }` with the one plain-language line a user would read, or ' +
      "`{ section: 'Skip', userFacing: '-' }` when the change has no user-facing half. " +
      'Use `dropped` instead if this turned out not to be work — that closes it without the claim.',
    details: { requires: 'releaseNotes' },
  };
}
