/**
 * The words a mark's answer carries about what it did (`merge-marker.ts:writeMarkTrail`): its kind's
 * description, what the marker said and the repository read, and, where they apply, that it amended
 * an evidence-free mark (ISS-1345) or an asserted one (ISS-1445) in place, or names no evidence at all.
 */

import type { AdoptionHeld } from '@forge/contracts/ecosystem';
import type { CommitLanding, CommitReading } from './commit-landing.js';
import * as designMark from './design-mark.js';
import {
  amendedAssertedSentence,
  amendedSentence,
  evidenceFreeSentence,
  type LandingShape,
} from './landing-evidence.js';
import { type MarkSaid, saidSentence } from './mark-said.js';
import { describeAdoptionMark, describeMergeMark, type MergeMarkKind } from './merge-mark-kind.js';
import type { MergeRecord } from './merge-record.js';

/** What a mark left, as far as its words need: the stamp, the claim it carried and what amended. */
export interface MarkStampWords {
  result: MergeRecord;
  claimedCommit: string | null;
  readFrom: Extract<CommitLanding, { ok: true }> | null;
  adopted?: AdoptionHeld[] | null;
  amended?: Date | null;
  amendedAsserted?: AmendedAsserted | null;
  shape?: LandingShape;
}

/** The asserted mark an observed commit amended in place (ISS-1445): its time, the commit it claimed,
 *  and the commit of the paths a box read for it, which the amend dropped. */
export interface AmendedAsserted {
  at: Date;
  claimed: string | null;
  pathsAt: string | null;
}

export function markDetailOf(args: {
  marking: boolean;
  mark: MergeMarkKind;
  stamp: MarkStampWords;
  said: MarkSaid;
  reading: CommitReading | null;
  commit: string | null;
  claimedTarget: string | null;
}): string {
  const { marking, mark, stamp, said, reading, commit, claimedTarget } = args;
  const { result, readFrom } = stamp;
  const kindDetail =
    stamp.adopted && result.wrote
      ? describeAdoptionMark(stamp.adopted)
      : (designMark.designStampDetail(result) ??
        describeMergeMark({
          kind: mark,
          commitSha: result.commitSha,
          claimedCommit: stamp.claimedCommit,
          landing: result.landing,
          ...(readFrom && result.wrote ? { readFrom } : {}),
          target: result.target,
          claimedTarget,
        }));
  if (!marking) return kindDetail;
  const evidenceFree = mark === 'asserted' && !commit && !result.artifacts?.length && stamp.shape;
  return [
    `${kindDetail}.`,
    saidSentence(said, reading),
    ...(stamp.amended ? [amendedSentence(stamp.amended)] : []),
    ...(stamp.amendedAsserted ? [amendedAssertedSentence(stamp.amendedAsserted)] : []),
    ...(evidenceFree ? [evidenceFreeSentence(evidenceFree)] : []),
  ].join(' ');
}
