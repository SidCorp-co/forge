// An ended release attempt's abort, as a reader is told it: the one reading of `metadata.abort` (and
// the `carried` it said) that a run's `/state` and its release's attempts both answer with, so the
// two reads cannot tell one abort two ways (ISS-1095). A run cancelled with no abort on record says
// so by name, never reading the same as an explained one.

import type {
  ReleaseAbortView,
  ReleasePerson,
  ReleaseVersionCarrier,
} from '@forge/contracts/releases';
import { readRunFailure } from '../pipeline/index.js';
import { readAbortStamp } from './abort-stamp.js';
import { carriersOf, type LineageRun } from './version-rule.js';

/** The failure a close records on a release run cancelled with no abort (`runs-cascade.ts`). */
const CANCELLED_WITHOUT_ABORT = 'release_cancelled_without_abort';

export const NO_ABORT_RECORDED =
  'This run was cancelled and no abort was recorded on it: nothing on record says why, who ended it, who owes the next act, or what left its box.';

type AbortedRun = Pick<LineageRun, 'status' | 'releasedAt' | 'metadata' | 'reachedBox'>;

/** What outside Forge carries an attempt's version: `[]` where it was said nothing does, null where nobody said. */
export function carriedOf(
  run: Pick<LineageRun, 'metadata' | 'reachedBox'>,
): ReleaseVersionCarrier[] | null {
  const reading = carriersOf(run);
  return reading.kind === 'carried' ? reading.carriers : reading.kind === 'none' ? [] : null;
}

/** The user an abort names as its actor, to be read with the other people a read names. */
export function abortActorOf(metadata: unknown): string | null {
  const by = readAbortStamp(metadata)?.by;
  return by ? by : null;
}

/**
 * How `run` was aborted: its recorded account, `recorded: false` where it was cancelled with no
 * abort on record, null where no abort began and nobody cancelled it. `people` holds the actor.
 */
export function abortViewOf(
  run: AbortedRun,
  people: ReadonlyMap<string, ReleasePerson>,
): ReleaseAbortView | null {
  const stamp = readAbortStamp(run.metadata);
  if (stamp) {
    return {
      recorded: true,
      reason: stamp.reason,
      by: (stamp.by && people.get(stamp.by)) || null,
      at: stamp.at || null,
      blocker: stamp.blocker ?? null,
      pushed: stamp.pushed ?? null,
      roster: stamp.roster,
      carried: carriedOf(run),
    };
  }
  if (run.releasedAt !== null) return null;
  const cancelled =
    run.status === 'cancelled' || readRunFailure(run.metadata)?.code === CANCELLED_WITHOUT_ABORT;
  return cancelled ? { recorded: false, says: NO_ABORT_RECORDED } : null;
}
