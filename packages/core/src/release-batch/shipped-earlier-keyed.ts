/**
 * The keyed half of `shipped-earlier.ts`: an `asserted` mark names no commit, so the commits that
 * declare the issue (`commitOwners`, the rule the live reading places commits with) are read from
 * each recent shipped release's own range, and the issue is placed in the release whose range holds
 * the last one, provided none is left in the range from the newest release to the branch head.
 */

import type { SourceHost, WaitingCommit } from '../integrations/source-host/index.js';
import { heldIssuePrefixes } from '../issues/index.js';
import { readLandingBranches } from '../project-config/index.js';
import { commitOwners, issueRefPattern } from '../projects/index.js';

/** A release Forge verified shipping: the version it cut and the commit production served. */
export interface ShippedRelease {
  runId: string;
  version: string;
  commit: string;
}

/** How far back the keyed reading looks: this many shipped releases' own ranges, newest first. */
const KEYED_WINDOW = 12;

// A range between two commits never changes, so one read is kept for the process, bounded.
const RANGES = new Map<string, WaitingCommit[]>();
const RANGES_LIMIT = 200;

async function rangeOf(host: SourceHost, base: string, head: string): Promise<WaitingCommit[]> {
  const key = `${base}..${head}`;
  const held = RANGES.get(key);
  if (held) return held;
  const read = await host.readRange(base, head);
  if (!read.ok) throw new Error(`${base}..${head} could not be read: ${read.reason}`);
  if (!read.complete) {
    throw new Error(
      `${base}..${head} holds more commits than one reading takes, so it is unplaced`,
    );
  }
  if (RANGES.size >= RANGES_LIMIT) RANGES.delete(RANGES.keys().next().value as string);
  RANGES.set(key, read.commits);
  return read.commits;
}

/**
 * Which release's own range holds the last commit declaring each of `rows`, for the rows none of
 * whose declaring commits is still unreleased. A row no range declares is not placed: it takes the
 * normal path. Throws where a range cannot be read whole.
 */
export async function placeByKey(
  host: SourceHost,
  projectId: string,
  releases: readonly ShippedRelease[],
  rows: ReadonlyArray<{ id: string; issSeq: number }>,
): Promise<Map<string, ShippedRelease>> {
  const placed = new Map<string, ShippedRelease>();
  const newest = releases[releases.length - 1];
  if (rows.length === 0 || releases.length < 2 || !newest) return placed;
  const { defaultBranch } = await readLandingBranches(projectId);
  if (!defaultBranch) {
    throw new Error(
      'the project document declares no `source.git.defaultBranch` to read the unreleased range on',
    );
  }
  const pattern = issueRefPattern(await heldIssuePrefixes(projectId));
  const owned = (commits: WaitingCommit[]): Set<number> => {
    const seqs = new Set<number>();
    for (const bySeq of commitOwners(commits, pattern, defaultBranch).values()) {
      for (const seq of bySeq.keys()) seqs.add(seq);
    }
    return seqs;
  };

  const unreleased = owned(
    await rangeOf(host, newest.commit, await host.branchHead(defaultBranch)),
  );
  const first = Math.max(1, releases.length - KEYED_WINDOW);
  const ranges: Array<{ release: ShippedRelease; seqs: Set<number> }> = [];
  for (let i = first; i < releases.length; i += 1) {
    const prev = releases[i - 1] as ShippedRelease;
    const release = releases[i] as ShippedRelease;
    ranges.push({ release, seqs: owned(await rangeOf(host, prev.commit, release.commit)) });
  }
  for (const row of rows) {
    if (unreleased.has(row.issSeq)) continue;
    const last = [...ranges].reverse().find((r) => r.seqs.has(row.issSeq));
    if (last) placed.set(row.id, last.release);
  }
  return placed;
}
