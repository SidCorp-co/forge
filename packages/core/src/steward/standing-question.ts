// The question a dated decision answers (ISS-804, FB-396). A decision recorded on an item answers the
// steward's ask on the standing it was recorded on; one that names its own date (`until`) answers it
// until that date while the question the standing puts is the same. A dependent waiting on a live
// blocker puts one question whichever step that blocker is on: its wait names the blocker's act
// (`issues/standing-held.ts:blockerAct`), and the blocker moving open → in_progress, or pausing, or
// coming back, changes that act and so the standing's basis, never the question. The blocker settling
// ends the wait on it (another blocker, or none, is waited on), and a design hold on a settled blocker
// is another act; both are another question. FB-396: ISS-6's dated decision was voided minutes after
// it was written, when its blocker ISS-4 was taken, and the steward asked the master again.

import { LIVE_BLOCKER_ACT_KEYS } from '../issues/index.js';

/** The fields of a basis (`contracts/steward.ts:standingBasisOf`), and where act and due sit among them. */
const FIELDS = 8;
const ACT = 3;
const DUE = 6;
const ANY = '*';

/**
 * The question a standing's basis puts: the basis itself, but where it waits on a live blocker, whose
 * act (and the due that act's class gives it) reads as any live blocker's. A blocker's `who` and
 * `ref` are its key, which holds no separator; a basis that does not split into its fields reads
 * strictly, as its own question, since which field is the act cannot be told.
 */
export function questionOfBasis(basis: string): string {
  const parts = basis.split('|');
  if (parts.length !== FIELDS || parts[1] !== 'issue') return basis;
  if (!LIVE_BLOCKER_ACT_KEYS.has(parts[ACT] as string)) return basis;
  parts[ACT] = ANY;
  parts[DUE] = ANY;
  return parts.join('|');
}
