/**
 * A screen that admits whatever it is shown, for tests that are not about screening.
 *
 * Since ISS-978 a passing verdict carries the segments it was passed over, and a
 * proof is minted only where those match what is about to be sent. So a mock
 * that answers a bare `ok` records nothing, mints nothing, and silently turns
 * every delivery in that file into a code-authored fallback — which passes as a
 * green until somebody reads what the room actually received.
 *
 * Fourteen test files needed the same four lines to say that. They say it here.
 */

import type { MessageVerdict } from './contract.js';
import { admitted } from './screen.js';

/** Stands in for `screenReplyAtDoor`: admits the segments it was handed. */
// cm:guard this file is named in `verdict-mint.test.ts`'s allowlist rather than excluded from its
// scan, because it IS a mint and hiding it behind a filename pattern is how a producer comes to live
// in a `.fixture.ts` that nothing watches. It admits everything, so it belongs to tests only — a
// `src/` caller reaching for it is exactly what that scan is there to catch.
export const screenPasses = async (
  _door: unknown,
  input: { segments: readonly string[] },
): Promise<MessageVerdict> => admitted(input.segments);

/** Stands in for `screenAtDoor`, which is synchronous and takes the segments directly. */
export const screenAtDoorPasses = (_door: unknown, segments: readonly string[]): MessageVerdict =>
  admitted(segments);
