/**
 * A pass on a later build that holds an issue's landing is a pass on the delivered work (REQ-36
 * BC-18): the testing environment serves such a build, and `judged-build.ts` sends the judge to it.
 * `laterHoldersOf` is the one reading of that hold, and `earlierCarriageOf` of a landing's descent
 * from an earlier pass (ISS-845), both answered from the landings Forge recorded
 * (`recorded-holding.ts:recordedHolding`) and never from the host, and both a requirement's coverage
 * (`landedBuildHolds`, `requirements/standing-coverage.ts`) and the automatic release's landing
 * basis (`criteria-basis.ts:landingCriteriaReports`) read them. A release record keeps its own rule:
 * the recorded commit must hold the verdict's (`landing-coverage.ts`).
 */

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { landedCommitOf } from '@forge/contracts/verdict-identity';
import type { Carriage } from '../issues/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { pairKey } from '../runners/index.js';
import {
  deliveredBuildsOf,
  deliveryOf,
  type Holding,
  holdingPair,
  type LandedBuild,
} from './landed-build.js';
import { recordedHolding } from './recorded-holding.js';

/** One issue's landed build, or why it has none. */
export interface LandedHolds {
  sha: string | null;
  /** Why the issue has no landed build; null where it has one. */
  why: string | null;
  /** Where the build is a host merge commit: the request's head and whether its tree is the build's. */
  head?: MergedHead | null;
  /** Per later commit a verdict on the issue names, whether it holds the build, or why not read. */
  holders?: Map<string, Holding>;
  /** Per other commit a verdict on the issue names, what the build holds of it (`earlierCarriageOf`). */
  descent?: Map<string, Carriage>;
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
 * (REQ-36 BC-18), and what that build holds of each such commit, so a pass at an earlier landing it
 * descends from is carried to it as the release hold carries it (ISS-845, `earlierCarriageOf`): the
 * same commit reading (contracts `landedCommitOf`) the record door uses, answered from the landings
 * Forge recorded (`recorded-holding.ts`) and never from the host. An open request's
 * head is not a landing, so nothing is read for it. Null on a project with production, whose coverage reads the live build
 * (`judged-build.ts:liveBuildHolds`).
 */
export async function landedBuildHolds(
  projectId: string,
  issueIds: readonly string[],
  judged: ReadonlyMap<string, readonly JudgedAgainst[]> = new Map(),
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
  const [holders, carriage] = await Promise.all([
    laterHoldersOf(projectId, builds, judged, () => judgedOn),
    earlierCarriageOf(projectId, builds, judged, () => judgedOn),
  ]);
  const landed = new Map<string, LandedHolds>();
  for (const [issueId, build] of builds) {
    const asked = holders.get(issueId);
    const descent = carriage.get(issueId);
    landed.set(issueId, {
      sha: build.sha,
      why: build.sha === null ? build.why : null,
      ...(build.sha !== null && build.head ? { head: build.head } : {}),
      ...(asked ? { holders: asked } : {}),
      ...(descent ? { descent } : {}),
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
  judgedOnFor: (issueId: string) => string | null,
): Map<string, { landing: string; shas: string[] }> {
  const out = new Map<string, { landing: string; shas: string[] }>();
  for (const [issueId, against] of judged) {
    const build = builds.get(issueId.toLowerCase());
    if (!build || build.sha === null || build.from === 'change-request') continue;
    const shas = new Set<string>();
    for (const at of against) {
      const named = landedCommitOf(at.kind, at.value, judgedOnFor(issueId));
      if ('sha' in named && named.sha !== build.sha) shas.add(named.sha);
    }
    if (shas.size > 0) out.set(issueId.toLowerCase(), { landing: build.sha, shas: [...shas] });
  }
  return out;
}

/**
 * Per issue whose build is a landing, whether each later commit its verdicts name holds that landing,
 * or why that was not read: the one reading of a pass on a later build, answered from the landings
 * Forge recorded (`recorded-holding.ts`), never from the host.
 */
export async function laterHoldersOf(
  projectId: string,
  builds: ReadonlyMap<string, LandedBuild>,
  judged: ReadonlyMap<string, readonly JudgedAgainst[]>,
  judgedOnFor: (issueId: string) => string | null,
): Promise<Map<string, Map<string, Holding>>> {
  const later = laterCommitsOf(builds, judged, judgedOnFor);
  const answers = await recordedHolding(
    projectId,
    [...later.values()].flatMap(({ landing, shas }) =>
      shas.map((sha) => holdingPair(landing, sha)),
    ),
  );
  const out = new Map<string, Map<string, Holding>>();
  for (const [issueId, { landing, shas }] of later) {
    out.set(
      issueId,
      new Map(
        shas.map((sha): [string, Holding] => [
          sha,
          answers.get(pairKey(holdingPair(landing, sha))) ?? {
            unread: 'the ancestry reader gave no answer',
          },
        ]),
      ),
    );
  }
  return out;
}

const short = (sha: string) => sha.slice(0, 12);

/** A holding answer as a carriage: `by` names the record where it descends. */
function carriageOfHolding(held: Holding | undefined, by: string): Carriage {
  if (held === true) return { kind: 'descends', by };
  if (held === false)
    return { kind: 'lacks', why: 'the ancestry reader answered that it does not' };
  return { kind: 'unread', why: held?.unread ?? 'the ancestry reader gave no answer' };
}

/**
 * Per issue whose build is a landing, what that landing holds of each other commit its verdicts
 * name (ISS-845): it descends from one where a landing Forge recorded at that commit, on the same
 * branch, came no later (`recorded-holding.ts`, a fix round's own earlier landing among them), and
 * otherwise whether it does was not read. Never from the host, so the files between are not read.
 */
export async function earlierCarriageOf(
  projectId: string,
  builds: ReadonlyMap<string, LandedBuild>,
  judged: ReadonlyMap<string, readonly JudgedAgainst[]>,
  judgedOnFor: (issueId: string) => string | null,
): Promise<Map<string, Map<string, Carriage>>> {
  const other = laterCommitsOf(builds, judged, judgedOnFor);
  const answers = await recordedHolding(
    projectId,
    [...other.values()].flatMap(({ landing, shas }) =>
      shas.map((sha) => holdingPair(sha, landing)),
    ),
  );
  const out = new Map<string, Map<string, Carriage>>();
  for (const [issueId, { landing, shas }] of other) {
    const carried = new Map<string, Carriage>();
    for (const sha of shas) {
      const held = answers.get(pairKey(holdingPair(sha, landing)));
      const by = `Forge recorded \`${short(sha)}\` landing on its branch before \`${short(landing)}\``;
      carried.set(sha, carriageOfHolding(held, by));
    }
    out.set(issueId, carried);
  }
  return out;
}
