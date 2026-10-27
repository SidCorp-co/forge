/**
 * A requirement's coverage reading of the builds its issues landed as, on a project with no
 * production environment (`requirements/standing-coverage.ts`): each issue's delivered build
 * (`landed-build.ts:deliveredBuildsOf`) and, for the later commits its verdicts name, whether each
 * holds that build (REQ-36 BC-18), through the reader the record door weighs a landing with
 * (`landed-build.ts:readHolding`).
 */

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { landedCommitOf } from '@forge/contracts/verdict-identity';
import { readProjectDocument } from '../project-config/index.js';
import { pairKey } from '../runners/index.js';
import type { JudgedBuildDeps } from './judged-build.js';
import {
  deliveredBuildsOf,
  deliveryOf,
  type Holding,
  holdingPair,
  type LandedBuild,
  readHolding,
} from './landed-build.js';

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  /** Why the issue has no landed build; null where it has one. */
  why: string | null;
  /** Where the build is a host merge commit: the request's head and whether its tree is the build's. */
  head?: MergedHead | null;
  /** Per later commit a verdict on the issue names, whether it holds the build, or why not read. */
  holders?: Map<string, Holding>;
}

/** What a verdict was judged against, as coverage hands it over: its identity's kind and value. */
export interface JudgedAgainst {
  kind: string;
  value: string;
}

/**
 * A requirement's coverage reading on a project with no production environment
 * (`requirements/standing-coverage.ts`): each issue's landed build (on a change-request project,
 * its request's unchanged head or host merge commit), rather than a production probe that cannot
 * exist, and, per issue in `judged`, whether each later commit its verdicts name holds that build
 * (REQ-36 BC-18): the same commit reading (contracts `landedCommitOf`) and the same ancestry reader
 * (`readHolding`) the record door weighs a landing with. An open request's head is not a landing,
 * so nothing is asked of it. Null on a project with production, whose coverage reads the live build
 * (`judged-build.ts:liveBuildHolds`).
 */
export async function landedBuildHolds(
  projectId: string,
  issueIds: readonly string[],
  judged: ReadonlyMap<string, readonly JudgedAgainst[]> = new Map(),
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<{
  sha: null;
  holds: Map<string, boolean>;
  runtimes: Map<string, string | null>;
  unanswered: Map<string, string>;
  landed: Map<string, LandedHolds>;
  judgedOn: string | null;
} | null> {
  const delivery = await deliveryOf(projectId);
  if (!delivery) return null;
  const ids = [...new Set(issueIds.map((id) => id.toLowerCase()))];
  const [builds, held] = await Promise.all([
    deliveredBuildsOf(projectId, delivery, ids),
    readProjectDocument(projectId),
  ]);
  const judgedOn = judgedOnOf(held?.document.delivery);
  const later = laterCommitsOf(builds, judged, judgedOn);
  const answers = await readHolding(
    projectId,
    [...later.values()].flatMap(({ landing, shas }) =>
      shas.map((sha) => holdingPair(landing, sha)),
    ),
    deps,
  );
  const landed = new Map<string, LandedHolds>();
  for (const [issueId, build] of builds) {
    const asked = later.get(issueId);
    landed.set(issueId, {
      sha: build.sha,
      why: build.sha === null ? build.why : null,
      ...(build.sha !== null && build.head ? { head: build.head } : {}),
      ...(asked
        ? {
            holders: new Map(
              asked.shas.map((sha): [string, Holding] => [
                sha,
                answers.get(pairKey(holdingPair(asked.landing, sha))) ?? {
                  unread: 'the ancestry reader gave no answer',
                },
              ]),
            ),
          }
        : {}),
    });
  }
  return {
    sha: null,
    holds: new Map(),
    runtimes: new Map(),
    unanswered: new Map(),
    landed,
    judgedOn,
  };
}

/**
 * Per issue whose build is a landing, the whole commits other than it that its verdicts name, by the
 * one reading of a verdict's commit on a landing (contracts `landedCommitOf`).
 */
function laterCommitsOf(
  builds: ReadonlyMap<string, LandedBuild>,
  judged: ReadonlyMap<string, readonly JudgedAgainst[]>,
  judgedOn: string | null,
): Map<string, { landing: string; shas: string[] }> {
  const out = new Map<string, { landing: string; shas: string[] }>();
  for (const [issueId, against] of judged) {
    const build = builds.get(issueId.toLowerCase());
    if (!build || build.sha === null || build.from === 'change-request') continue;
    const shas = new Set<string>();
    for (const at of against) {
      const named = landedCommitOf(at.kind, at.value, judgedOn);
      if ('sha' in named && named.sha !== build.sha) shas.add(named.sha);
    }
    if (shas.size > 0) out.set(issueId.toLowerCase(), { landing: build.sha, shas: [...shas] });
  }
  return out;
}
