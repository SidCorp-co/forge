// The question a dated decision answers (ISS-804, FB-396). A decision recorded on an item answers the
// steward's ask on the standing it was recorded on; one that names its own date (`until`) answers it
// until that date while the question the standing puts is the same. A dependent waiting on a live
// blocker puts one question whichever step that blocker is on: its wait names the blocker's act
// (`issues/standing-held.ts:blockerAct`), and the blocker moving open → in_progress, or pausing, or
// coming back, changes that act and so the standing's basis, never the question. The blocker settling
// ends the wait on it (another blocker, or none, is waited on), and a design hold on a settled blocker
// is another act; both are another question. On dev.434 ISS-6's dated decision was voided minutes
// after it was written, when its blocker ISS-4 was taken, and the steward asked the master again.

import { LIVE_BLOCKER_ACT_KEYS } from '../issues/index.js';

/** The fields after `who` in a basis (`contracts/steward.ts:standingBasisOf`): act, ref, stuck, due, carrier. */
const TAIL = 5;
const ANY = '*';

/**
 * The question a standing's basis puts: the basis itself, but where it waits on a live blocker, whose
 * act (and the due that act's class gives it) reads as any live blocker's. `who` may hold the
 * separator, so the fields are read from both ends; a string that is no standing basis is its own
 * question.
 */
export function questionOfBasis(basis: string): string {
  const parts = basis.split('|');
  if (parts.length < 3 + TAIL) return basis;
  const at = parts.length - TAIL;
  if (parts[1] !== 'issue' || !LIVE_BLOCKER_ACT_KEYS.has(parts[at] as string)) return basis;
  parts[at] = ANY;
  parts[at + 3] = ANY;
  return parts.join('|');
}
