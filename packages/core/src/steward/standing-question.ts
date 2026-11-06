// The question a dated or conditioned decision answers (ISS-804, FB-396, ISS-1037). A decision recorded
// on an item answers the steward's ask on the standing it was recorded on; one that names its own date
// or a condition (`until`, `reversedWhen`) answers it while the question the standing puts is the
// same: the act owed, by whom, on what. A dependent waiting on a live blocker puts one question
// whichever step that blocker is on: its wait names the blocker's act
// (`issues/standing-held.ts:blockerAct`), and the blocker moving open → in_progress, or pausing, or
// coming back, changes that act and so the standing's basis, never the question. The blocker settling
// ends the wait on it (another blocker, or none, is waited on), and a design hold on a settled blocker
// is another act; both are another question. FB-396: ISS-6's dated decision was voided minutes after
// it was written, when its blocker ISS-4 was taken, and the steward asked the master again.
// A wait turning stuck or overdue on its own clock changes its group, its stuck code and its due, and
// none of them is another act owed: the same question. FB-534 (sidpeak): REQ-9..11's decisions dated
// 2026-11-12 were voided the day after they were written, when each draft read stuck `overdue`, and
// the steward asked again about all eleven requirements.

import { LIVE_BLOCKER_ACT_KEYS } from '../issues/index.js';

/** The fields of a basis (`contracts/steward.ts:standingBasisOf`), and where each the clock moves sits. */
const FIELDS = 8;
const GROUP = 0;
const ACT = 3;
const STUCK = 5;
const DUE = 6;
const ANY = '*';

/**
 * The question a standing's basis puts: the act owed, by whom, on what, and what carries it; its
 * group, stuck code and due, which the clock moves, read as any. Where it waits on a live blocker,
 * the blocker's act reads as any live blocker's too. A blocker's `who` and `ref` are its key, which
 * holds no separator; a basis that does not split into its fields reads strictly, as its own
 * question, since which field is the act cannot be told.
 */
export function questionOfBasis(basis: string): string {
  const parts = basis.split('|');
  if (parts.length !== FIELDS) return basis;
  parts[GROUP] = ANY;
  parts[STUCK] = ANY;
  parts[DUE] = ANY;
  if (parts[1] === 'issue' && LIVE_BLOCKER_ACT_KEYS.has(parts[ACT] as string)) parts[ACT] = ANY;
  return parts.join('|');
}
