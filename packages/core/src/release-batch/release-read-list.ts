// The release lists (ISS-1070): every release, those that can still wait on someone, the newest
// shipped, and the newest live, each read through one placing (`summariseChosen`) that weighs only
// the releases it returns. One release's record is `release-read.ts:readReleaseRecord`.

import type {
  ReleaseListResponse,
  ReleaseShippedResponse,
  ReleaseState,
  ReleaseSummary,
} from '@forge/contracts/releases';
import { RELEASE_ATTENTION_GROUPS } from '@forge/contracts/releases';
import { approvalRequired } from '../project-config/index.js';
import { readEndedRunHolds } from './ended-claims.js';
import { landingRecordsOf } from './landing-records.js';
import { fillCuts, releaseLinesOf } from './release-cuts.js';
import {
  placeDraft,
  placeParts,
  productionOf,
  runParts,
  sharedFor,
  weighDraft,
} from './release-read.js';
import { type Part, summaryOf } from './release-read-views.js';
import type { ViewerFacts } from './release-view.js';
import { currentReleaseVersion, readLineage } from './version-store.js';

export async function listReleases(
  projectId: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseListResponse> {
  const { releases, current, required } = await summariseChosen(projectId, viewer, (all) => all);
  const counts = Object.fromEntries(
    RELEASE_ATTENTION_GROUPS.map((a) => [a, releases.filter((r) => r.attentionGroup === a).length]),
  ) as ReleaseListResponse['counts'];
  // A landing recorded before versioning stays listed after the project declares production; an
  // ended run still claiming gate issues is in no part's roster: it is named here with its act
  const [production, landings, endedRunHolds] = await Promise.all([
    productionOf(projectId, current),
    landingRecordsOf(projectId),
    readEndedRunHolds(projectId),
  ]);
  return { releases, counts, approvalRequired: required, production, landings, endedRunHolds };
}

/** Whether a release in `state` can still wait on someone: one shipped, failed or aborted waits on nobody (`release-view.ts:turnOf`). */
function mayStillWait(state: ReleaseState): boolean {
  switch (state) {
    case 'shipped':
    case 'failed':
    case 'aborted':
      return false;
    default:
      return true;
  }
}

/**
 * Every release that can still wait on someone, each summarised as the whole list summarises it:
 * what Needs you reads its release rows and decisions from. A release shipped, failed or aborted
 * waits on nobody, so weighing the hundreds a project has shipped was the read's cost and none of
 * its answer (ISS-1070).
 */
export async function listReleasesInPlay(
  projectId: string,
  viewer: ViewerFacts | null,
): Promise<Pick<ReleaseListResponse, 'releases'>> {
  const { releases } = await summariseChosen(projectId, viewer, (listed) =>
    listed.filter((p) => mayStillWait(p.state)),
  );
  return { releases };
}

/** The releases that went out (shipped or landed on testing), newest first. */
const wentOut = (parts: readonly Part[]): Part[] =>
  parts
    .filter((p) => p.releasedAt !== null)
    .sort((a, b) => (b.releasedAt?.getTime() ?? 0) - (a.releasedAt?.getTime() ?? 0));

/**
 * The releases `choose` picks, summarised: every release is placed, and only the chosen are weighed,
 * the draft's gates and approval among them, so a read that shows a few never pays for the whole
 * list (ISS-1070). A release is listed once,
 * under the version its last attempt wears: a version its roster went on from is one of that
 * release's attempts, not a release of its own (ADR 0011).
 */
async function summariseChosen(
  projectId: string,
  viewer: ViewerFacts | null,
  choose: (listed: Part[]) => Part[],
): Promise<{ releases: ReleaseSummary[]; current: string | null; required: boolean }> {
  const [required, current] = await Promise.all([
    approvalRequired(projectId),
    currentReleaseVersion(projectId),
  ]);
  const [runs, draft, lineage] = await Promise.all([
    runParts(projectId, undefined, required),
    placeDraft(projectId),
    readLineage(projectId),
  ]);
  const placed = placeParts(releaseLinesOf(lineage), runs, draft);
  const parts = choose(placed.parts.filter((p) => p.continuedAs === null));
  // the draft's gates, naming and approval are read only where the draft is one of the chosen
  const [shared] = await Promise.all([
    sharedFor(
      projectId,
      parts,
      viewer,
      current,
      required,
      parts.flatMap((p) => placed.groupOf(p).map((r) => r.id)),
    ),
    draft && parts.includes(draft.part) ? weighDraft(projectId, draft.part) : null,
  ]);
  await fillCuts(projectId, parts, placed.groupOf, shared.facts.cutters);
  return { releases: parts.map((p) => summaryOf(p, shared)), current, required };
}

/** The newest `limit` releases that went out, newest first: `GET releases/shipped?limit=n`. */
export async function listShippedReleases(
  projectId: string,
  viewer: ViewerFacts | null,
  limit: number,
): Promise<ReleaseShippedResponse> {
  const { releases } = await summariseChosen(projectId, viewer, (listed) =>
    wentOut(listed).slice(0, limit),
  );
  return { releases };
}

/**
 * The newest release on production and the newest on testing, with what production is: what a
 * person's home names as live, read without the whole list (ISS-1070).
 */
export async function latestLiveReleases(
  projectId: string,
): Promise<Pick<ReleaseListResponse, 'releases' | 'production'>> {
  const { releases, current } = await summariseChosen(projectId, null, (listed) => {
    const out = wentOut(listed);
    return [out.find((p) => p.state === 'shipped'), out.find((p) => p.state === 'landed')].filter(
      (p): p is Part => p !== undefined,
    );
  });
  return { releases, production: await productionOf(projectId, current) };
}
