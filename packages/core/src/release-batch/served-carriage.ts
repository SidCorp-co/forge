// ISS-1290 — a pass judged at a later served build counts on the release that shipped the issue, where
// that build carries the release's change unchanged. forge-dev deploys every push, so a judge sent
// for 0.4.0-dev.716 found 0.4.0-dev.717 (4198c1a6) served and recorded ISS-1272 c1 there; 4198c1a6
// descends from dev.716's head eff4f0b5, its added commits touch none of the issue's files, and the
// release still read 0 of 33 proven, because a commit verdict counted only at the release's own
// build. The carriage is the one judged-build reads (`served-over.ts:servedOver`), never a second
// path: what it cannot read stays uncounted and the release's criterion names why.

import type { JudgedBuildIssue, ServedBuild } from '@forge/contracts/verdict-identity';
import { memoizedPerId } from '../db/read-memo.js';
import { carriageKey } from '../issues/index.js';
import type { IssueFact } from './release-facts.js';
import { persistedCarriage } from './served-ancestry.js';
import { type ServedOverDeps, servedOver } from './served-over.js';
import { keptRangesOf } from './shipped-range.js';
import { type ShippedReleaseRun, shippedReleaseRuns } from './shipped-releases.js';

const WHOLE = /^[0-9a-f]{40}$/;

/** Per issue, per `carriageKey(release head, later commit)`, what that commit holds of the release. */
export type ServedCarriages = ReadonlyMap<string, ReadonlyMap<string, ServedBuild>>;

export interface ServedCarriageDeps extends ServedOverDeps {
  releases(projectId: string): Promise<ShippedReleaseRun[]>;
}

const LIVE_DEPS: ServedCarriageDeps = {
  releases: shippedReleaseRuns,
  heldAncestry: persistedCarriage,
  // every issue's ask before a read's quiet point is one statement, however many releases it reads
  ranges: (runIds) => memoizedPerId('servedCarriageRanges', runIds, keptRangesOf),
};

/** The whole commits the issue's commit verdicts name, its voided ones included (`judged-before-reopen.ts`). */
function judgedCommitsOf(issue: IssueFact): string[] {
  const shas = new Set<string>();
  for (const list of [...issue.verdicts.values(), ...issue.voided.values()]) {
    for (const v of list) {
      const sha = v.identityKind === 'commit' ? v.commitSha?.trim().toLowerCase() : undefined;
      if (sha && WHOLE.test(sha)) shas.add(sha);
    }
  }
  return [...shas];
}

/**
 * What each commit an issue's commit verdicts name holds of every shipped release carrying the
 * issue, where the commit is not that release's own: read by `servedOver`, so a pass there counts on
 * the release only where it reads `unchanged` (`criterion-reading.ts`). Null on a project whose
 * releases are proven on a testing environment (`judgedOn`), where no commit verdict proves one.
 */
export async function servedCarriagesOf(
  projectId: string,
  facts: ReadonlyMap<string, IssueFact>,
  judgedOn: string | null,
  deps: ServedCarriageDeps = LIVE_DEPS,
): Promise<ServedCarriages | null> {
  if (judgedOn !== null) return null;
  const judged = [...facts.values()].flatMap((issue) => {
    const shas = judgedCommitsOf(issue);
    return shas.length > 0 ? [{ issue, shas }] : [];
  });
  if (judged.length === 0) return null;
  const releases = await deps.releases(projectId);
  const asked = judged.flatMap(({ issue, shas }) => {
    const heads = releases.filter((r) => r.issueIds.includes(issue.id)).map((r) => r.commit);
    return heads.flatMap((head) =>
      shas.filter((sha) => sha !== head).map((sha) => ({ issue, head, sha })),
    );
  });
  const answers = await Promise.all(
    asked.map(({ issue, head, sha }) =>
      servedOver(judgedIssueOf(projectId, issue), head, sha, releases, 'production', {
        ...deps,
        // an issue with no number reads its id as its key, which no commit subject names
        keyOf: async () => (issue.key === issue.id ? null : issue.key),
      }),
    ),
  );
  const out = new Map<string, Map<string, ServedBuild>>();
  asked.forEach(({ issue, head, sha }, i) => {
    const held = out.get(issue.id) ?? new Map<string, ServedBuild>();
    held.set(carriageKey(head, sha), answers[i] as ServedBuild);
    out.set(issue.id, held);
  });
  return out;
}

function judgedIssueOf(projectId: string, issue: IssueFact): JudgedBuildIssue {
  return {
    id: issue.id,
    projectId,
    mergedAt: issue.merged.at,
    mergedCommitSha: issue.merged.commitSha,
    mergedPaths: issue.merged.readPaths,
  };
}
