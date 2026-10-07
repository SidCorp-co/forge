/**
 * What a release batch carries to production, read from the project's repository (ISS-1386). On
 * a chain that promotes by `merge-branch`, the release merges the start branch into the live one,
 * so everything in `live...start` reaches production whether or not the batch names it. Read by
 * the caller and passed to the enumerator, which reaches no network of its own.
 */

import {
  chainCrossesByCherryPick,
  chainLiveBranch,
  chainStartBranch,
  type ReleaseChain,
} from '../projects/release-chain.js';
import { type RepositoryAccessDeps, withRepository } from '../projects/repository-access.js';
import type { RangeCommit } from '../projects/repository-reader.js';
import { readProjectBranches } from '../projects/service.js';

/** One read of `live...head`: every commit the head holds that the live branch does not. */
export interface ReadRange {
  live: string;
  start: string;
  /** The commit a release of this range promotes: the start branch's head, or a cut below it. */
  cut: string;
  commits: RangeCommit[];
}

export type CutRange =
  | ({ kind: 'read' } & ReadRange)
  /** The chain gives no branch range to read: a publish chain, or a cherry-pick crossing. */
  | { kind: 'not-read'; why: string }
  /** No route to read it was declared: no GitHub binding, and no deploy key beside an SSH URL. */
  | { kind: 'unbound'; why: string }
  /** A declared route failed to answer. */
  | { kind: 'unread'; why: string };

export type CutRangeDeps = Partial<RepositoryAccessDeps>;

/** The range a promotion of `head` onto the live branch carries; `head` defaults to the start branch. */
export async function readRangeTo(
  projectId: string,
  chain: ReleaseChain,
  head: string | null,
  deps: CutRangeDeps = {},
): Promise<CutRange> {
  const live = chainLiveBranch(chain);
  const start = chainStartBranch(chain);
  if (!live || !start) {
    return {
      kind: 'not-read',
      why: 'this project deploys the branch work merges to, so no branch range separates what a release carries',
    };
  }
  if (chainCrossesByCherryPick(chain)) {
    return {
      kind: 'not-read',
      why: 'this project crosses into production by cherry-pick, so a release carries only what it picks',
    };
  }
  return withRepository(
    projectId,
    async (access): Promise<CutRange> => {
      if (access.kind === 'refused') {
        return { kind: access.unbound ? 'unbound' : 'unread', why: access.why };
      }
      const { reader } = access;
      // Pinned to a sha first, so the range read and the cut the release is told to promote are one.
      let cut = head;
      if (!cut) {
        const tip = await reader.branchHead(start);
        if ('why' in tip) return { kind: 'unread', why: tip.why };
        cut = tip.sha;
      }
      const read = await reader.range(live, cut);
      if ('why' in read) return { kind: 'unread', why: read.why };
      return { kind: 'read', live, start, cut, commits: read.commits };
    },
    deps,
  );
}

/** The project's own chain, and the range a release of its start branch carries. */
export async function readCutRange(projectId: string, deps: CutRangeDeps = {}): Promise<CutRange> {
  const project = await readProjectBranches(projectId);
  return readRangeTo(projectId, project?.releaseChain ?? [], null, deps);
}
