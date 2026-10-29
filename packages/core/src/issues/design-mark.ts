/**
 * The mark of a design issue that carries no code (ISS-570, REQ-45 BC-4): the approved revisions it
 * drew are its landing, so a mark naming nothing — after its approval stamp was cleared, or where none
 * was ever written — is written again as each approval wrote it (`design-landing.ts:markApprovedDesign`),
 * and the issue closes through `design_delivered`. The mark writer (`merge-marker.ts`) calls these;
 * approved designs never stand in for code (`work-evidence.ts:findMissingWorkEvidence` is asked first).
 */

import { designArtifact } from '@forge/contracts/landing-artifacts';
import { db, type Tx } from '../db/client.js';
import type { Actor } from './activity.js';
import { approvedDesignsDrawn, designHoldPhrase, designHoldsOf } from './design-delivery.js';
import { designsLandingOf } from './design-landing.js';
import type { LandingShape } from './landing-evidence.js';
import { designOnlyStamp } from './merge-mark-kind.js';
import { type MergeRecord, recordDesignLanding, recordMergeTarget } from './merge-record.js';
import type { IssueRow } from './read-service.js';

export interface DesignMark {
  /** Per workflow, the newest approved revision the issue drew, `<flow>@rev<n>`. */
  refs: string[];
  /** Of those, the ones the issue's mark does not name yet. */
  unnamed: string[];
  /** The mark as the row held it before this call. */
  held: Omit<MergeRecord, 'wrote'>;
}

/** A mark naming no commit, landing, artifacts or paths: where the issue carries no code, it stands
 *  on the approved designs the issue drew. */
export function namesNothing(args: {
  commit?: string | undefined;
  landing?: string | undefined;
  artifacts?: readonly unknown[] | undefined;
  changedPaths?: unknown;
}): boolean {
  return !args.commit && !args.landing && !args.artifacts?.length && !args.changedPaths;
}

/** The approved revisions a design issue carrying no code is marked on; null where it drew none approved. */
export async function designsOfMark(prior: IssueRow): Promise<DesignMark | null> {
  const refs = await approvedDesignsDrawn(db, prior.id);
  if (refs.length === 0) return null;
  const named =
    designOnlyStamp({ ...prior, mergedArtifacts: prior.mergedArtifacts ?? null }) ??
    (prior.mergedArtifacts ?? []).filter((a) => a.surface === 'design').map((a) => a.ref);
  return {
    refs,
    unnamed: refs.filter((r) => !named.includes(r)),
    held: {
      mergedAt: prior.mergedAt,
      commitSha: prior.mergedCommitSha,
      landing: prior.mergedLanding,
      artifacts: prior.mergedArtifacts ?? null,
      target: prior.mergedTarget,
    },
  };
}

/** The drawn revisions still waiting on their approver, said beside NO_WORK_EVIDENCE: a design
 *  issue is marked on its approved revisions alone, so these are what it waits for. */
export async function designsWaiting(issueId: string): Promise<string> {
  const holds = (await designHoldsOf(db, [issueId])).get(issueId) ?? [];
  if (holds.length === 0) return '';
  return `. This issue drew a design, and ${designHoldPhrase(holds)}: a design issue is marked on its approved revisions alone, so it is marked once that approval lands`;
}

/**
 * The stamp of a mark standing on approved design revisions: each one the mark does not name yet
 * joins it through the approval's own write (`merge-record.ts:recordDesignLanding`), so the row reads
 * as the approvals left it. With every one named already nothing is written, as for any repeat.
 */
export async function stampDesigns(
  tx: Tx,
  args: { issue: { id: string }; target?: string | undefined; actor: { hookActor: Actor } },
  at: { shape: LandingShape; designs: DesignMark },
): Promise<MergeRecord> {
  const { issue, target, actor: by } = args;
  const issueId = issue.id;
  const actor = by.hookActor;
  let record: MergeRecord = { wrote: false, ...at.designs.held };
  for (const ref of at.designs.unnamed) {
    const { before: _before, ...stamp } = await recordDesignLanding(tx, {
      issueId,
      landingOf: at.shape === 'outside_git' ? designsLandingOf : null,
      artifact: designArtifact(ref),
      actor: { type: actor.type, id: actor.id, agency: actor.agency },
    });
    record = { ...stamp, wrote: record.wrote || stamp.wrote };
  }
  if (target) await recordMergeTarget(tx, issueId, target);
  return record;
}

/** The sentence a mark standing on approved design revisions alone carries, read off the row it
 *  left; null where the row holds anything but those (a mark that stood before, which it kept). */
export function designStampDetail(result: MergeRecord): string | null {
  const refs = designOnlyStamp({
    mergedAt: result.mergedAt,
    mergedCommitSha: result.commitSha,
    mergedLanding: null,
    mergedArtifacts: result.artifacts,
    mergedPaths: null,
  });
  if (!refs) return null;
  return `this mark is the approved design ${refs.join(', ')}, which Forge holds, not a merge of code: the issue carries no branch, commit or handoff, so that design is its landing. It closes through \`design_delivered\` (move it to \`closed\`), not a release`;
}
