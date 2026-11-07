/**
 * Where a commit a verdict names stands against its issue's recorded landing (ISS-981): the verdict
 * door refuses one that is neither the landing, nor a later commit holding it, nor an earlier commit
 * the landing descends from, since the weighing counts such a verdict for nothing
 * (`landed-build-holds.ts`). Asked first of the landings Forge recorded (`recorded-holding.ts`, the
 * reading `laterHoldersOf` and `earlierCarriageOf` make), then of the project's ancestry reader
 * (`judged-build.ts:ancestryOf`, the source host or the box's bound checkout) the record doors share.
 * A write may ask the host; no read path calls this. A `holds` the reader answered is kept
 * (`served-ancestry.ts:keepHolding`, ISS-1079), so a read weighing a pass at a shipped release's commit
 * answers it from the row and asks nothing: what the attach door and the verdict door learn stays.
 */

import { pairKey } from '../runners/index.js';
import { ancestryOf, type JudgedBuildDeps } from './judged-build.js';
import { type Holding, holdingPair } from './landed-build.js';
import { recordedHolding } from './recorded-holding.js';
import { keepHolding } from './served-ancestry.js';

export type CommitPlacement =
  /** `holds`: the commit holds the landing; `carried`: the landing descends from the commit. */
  | { placed: true; how: 'landing' | 'holds' | 'carried' }
  /** The ancestry reader answered that neither holds the other. */
  | { placed: false }
  /** Nobody could say, and why. */
  | { unread: string };

const unreadOf = (held: Holding | undefined): string | null =>
  held === undefined
    ? 'the ancestry reader gave no answer'
    : held === true || held === false
      ? null
      : held.unread;

/** Where `commit` stands against `landing` on the project, by the records and then the reader. */
export async function commitPlacedOnLanding(
  projectId: string,
  landing: string,
  commit: string,
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<CommitPlacement> {
  const built = landing.toLowerCase();
  const named = commit.toLowerCase();
  if (built === named) return { placed: true, how: 'landing' };
  const holds = holdingPair(built, named);
  const carried = holdingPair(named, built);
  const recorded = await recordedHolding(projectId, [holds, carried]);
  if (recorded.get(pairKey(holds)) === true) return { placed: true, how: 'holds' };
  if (recorded.get(pairKey(carried)) === true) return { placed: true, how: 'carried' };
  const read = await ancestryOf(projectId, [holds, carried], deps);
  const later = read.get(pairKey(holds));
  const earlier = read.get(pairKey(carried));
  if (later === true) {
    await keepHolding(projectId, built, named);
    return { placed: true, how: 'holds' };
  }
  if (earlier === true) {
    await keepHolding(projectId, named, built);
    return { placed: true, how: 'carried' };
  }
  if (later === false && earlier === false) return { placed: false };
  return { unread: unreadOf(later) ?? unreadOf(earlier) ?? 'the ancestry reader gave no answer' };
}
