/**
 * The words a mark's answer carries about what it did (`merge-marker.ts:writeMarkTrail`): its kind's
 * description, what the marker said and the repository read, and, where they apply, that it amended
 * an evidence-free mark in place (ISS-1345) or names no evidence at all.
 */

import type { AdoptionHeld } from '@forge/contracts/ecosystem';
import type { CommitLanding, CommitReading } from './commit-landing.js';
import * as designMark from './design-mark.js';
import { amendedSentence, evidenceFreeSentence, type LandingShape } from './landing-evidence.js';
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
  shape?: LandingShape;
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
    ...(evidenceFree ? [evidenceFreeSentence(evidenceFree)] : []),
  ].join(' ');
}
