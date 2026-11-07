import type {
  IssueLandingReading,
  ReleaseDetail,
  ReleaseProduction,
  ReleaseShippedFailing,
} from '@forge/contracts/releases';
import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { feedbackAnsweredBy } from '../feedback/index.js';
import { notFound } from '../middleware/route-errors.js';
import { holderNames, namedHolders } from '../permissions/index.js';
import { type ReleaseRunRow, releaseRunsByIds } from '../pipeline/index.js';
import {
  approvalRequired,
  readContentLanguage,
  readOwedPolicy,
  readProjectDocument,
  readReleasePath,
} from '../project-config/index.js';
import { type ApprovalView, approvalsOfRuns, approvalViews } from './approvals.js';
import { collectReleaseBlockers } from './blockers.js';
import { mergeStepsOf, readChangeRequestLinks } from './change-request-roster.js';
import {
  productionProviderOf,
  type RecordedVerification,
  releaseVerifiedBy,
  resolveReleaseChannels,
} from './channel.js';
import { draftDecisionRefusal, standingDraftApproval } from './draft-approval.js';
import { draftVersionOf } from './draft-version.js';

// the Needs you read lists each project's releases: it primes their claimed gate rows at once
export { primeEndedRunClaims } from './ended-claims.js';

import { readFinishRecord } from './finish-record.js';
import { readLandingReadings } from './landing-surfaces.js';
import { draftNaming, readReleaseNaming } from './naming.js';
import { RECORDED_VERIFICATIONS } from './plan.js';
import { draftPromotionViewOf, promotionViewOf } from './promotion-release.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';
import { continuationOf, fillCuts, type ReleaseLines, releaseLinesOf } from './release-cuts.js';
import { loadReleaseFacts } from './release-facts.js';
import { gateViews } from './release-gates.js';
import { readReleaseOwes } from './release-owes.js';
import {
  detailOf,
  type Part,
  reworkedIn,
  type Shared,
  type WeighedIssue,
  weighedOf,
} from './release-read-views.js';
import { releaseTagOf } from './release-tag-record.js';
import type { ViewerFacts } from './release-view.js';
import { type CorrectionEntry, correctionsIn, correctionViews } from './shipped-in-correct.js';
import { parseReleaseVersion, RELEASE_VERSION_SHAPE } from './version.js';
import type { LineageRun } from './version-rule.js';
import { currentReleaseVersion, decideRosterVersion, readLineage } from './version-store.js';
import {
  attemptsOf,
  issueIdsOf,
  landedOffProduction,
  versionRuns,
  versionStatus,
} from './versions.js';

export interface DraftPart {
  part: Part;
  /** The attempt the next cut re-cuts, where it re-cuts one. */
  recutOf: string | null;
}

/**
 * The draft placed among the releases: its roster and the version it would wear, its gates, naming
 * and approval left unread until `weighDraft` (ISS-1070). A read that never shows the draft, such as
 * the newest shipped, places it, since the release it re-cuts folds into it, and weighs nothing more.
 */
export async function placeDraft(projectId: string): Promise<DraftPart | null> {
  const ids = await waitingIssueIds(projectId);
  if (ids.length === 0) return null;
  const decision = await decideRosterVersion(projectId, ids);
  return {
    recutOf: 'recutOf' in decision ? decision.recutOf.id : null,
    part: {
      version: draftVersionOf(decision),
      runId: null,
      state: 'draft',
      issueIds: ids,
      openedAt: null,
      releasedAt: null,
      attempts: [],
      approvals: [],
      gates: [],
      verification: null,
      commit: null,
      cuts: [],
      continuedAs: null,
      naming: null,
      mergeSteps: null,
      landedOn: null,
      shippedFailing: null,
      unapproved: null,
      tag: null,
      draftApproval: null,
      draftDecidable: false,
    },
  };
}

/** A placed draft's gates, naming and approval, read onto its part. */
export async function weighDraft(projectId: string, part: Part): Promise<void> {
  const ids = part.issueIds;
  const [report, admins, owes, naming, draftApproval, refused] = await Promise.all([
    collectReleaseBlockers(projectId, { issueIds: ids, door: 'batch' }),
    holderNames('project.admin', projectId),
    readReleaseOwes(projectId, ids),
    draftNaming(projectId, part.version),
    standingDraftApproval(projectId, part.version, ids),
    draftDecisionRefusal(projectId, part.version),
  ]);
  part.gates = gateViews(report.blockers, report.warnings, admins, owes);
  part.naming = naming;
  part.draftApproval = draftApproval;
  part.draftDecidable = refused === null;
}

/** The draft placed and weighed: what one release's record reads. */
async function draftPart(projectId: string): Promise<DraftPart | null> {
  const draft = await placeDraft(projectId);
  if (draft) await weighDraft(projectId, draft.part);
  return draft;
}

/**
 * Which release each part belongs to, and the attempts each shows (`release-cuts.ts`). A version
 * whose roster went on under another version reads `continuedAs` and lists no attempts of its own;
 * the draft takes the attempts of the release it re-cuts, and that release's versions fold into it.
 */
export function placeParts(
  lines: ReleaseLines,
  runs: Part[],
  draft: DraftPart | null,
): { parts: Part[]; groupOf: (p: Part) => LineageRun[] } {
  const draftKey = draft?.recutOf ? lines.keyOf.get(draft.recutOf) : undefined;
  for (const p of runs) {
    p.continuedAs =
      draft && draftKey !== undefined && p.runId && lines.keyOf.get(p.runId) === draftKey
        ? { version: draft.part.version, shipped: false }
        : continuationOf(lines, p.version, p.runId);
  }
  const groupOf = (p: Part): LineageRun[] => {
    if (p.state === 'draft')
      return draftKey === undefined ? [] : (lines.groups.get(draftKey) ?? []);
    if (
      p.continuedAs &&
      draft &&
      p.continuedAs.version === draft.part.version &&
      !p.continuedAs.shipped
    ) {
      return draftKey === undefined ? [] : (lines.groups.get(draftKey) ?? []);
    }
    const key = p.runId ? lines.keyOf.get(p.runId) : undefined;
    return key === undefined ? [] : (lines.groups.get(key) ?? []);
  };
  const parts = draft
    ? [draft.part, ...runs.filter((r) => r.version !== draft.part.version)]
    : runs;
  return { parts, groupOf };
}

/** The commit a finished release shipped (`shipped-commit.ts`); an attempt still in flight claims one only. */
function finishedCommit(metadata: unknown): string | null {
  const finish = readFinishRecord(metadata);
  return finish?.state === 'finished' ? finish.commit : null;
}

/** A cut release's part, with the shipped-in corrections its run keeps (ISS-846). */
type RunPart = Part & { corrections: CorrectionEntry[] };

function runPart(
  run: ReleaseRunRow,
  attempts: ReleaseAttemptRow[],
  approvals: ApprovalView[],
  required: boolean,
  deploysFrom: string | null,
): RunPart {
  return {
    version: run.version,
    runId: run.id,
    state: versionStatus(run, approvals[0] ?? null, required, deploysFrom),
    issueIds: issueIdsOf(run.metadata),
    openedAt: run.startedAt,
    releasedAt: run.releasedAt,
    attempts,
    approvals,
    gates: [],
    verification: recordedVerificationOf(run.metadata),
    commit: finishedCommit(run.metadata),
    cuts: [],
    continuedAs: null,
    naming: readReleaseNaming(run.metadata),
    mergeSteps: mergeStepsOf(run.metadata),
    landedOn: run.releasedAt ? landedOffProduction(run.metadata, deploysFrom) : null,
    shippedFailing: shippedFailingOf(run.metadata),
    unapproved: unapprovedOf(run.metadata),
    tag: releaseTagOf(run.metadata),
    draftApproval: null,
    draftDecidable: false,
    corrections: correctionsIn(run.metadata),
  };
}

/** What the recorded landing wrote it shipped failing, whole, or null where it wrote nothing. */
function shippedFailingOf(metadata: unknown): ReleaseShippedFailing | null {
  const held = (metadata as { shippedFailing?: ReleaseShippedFailing } | null)?.shippedFailing;
  return held && typeof held.sentence === 'string' && Array.isArray(held.criteria) ? held : null;
}

/** When a production act went ahead with no person's approval where one was advised (`unapproved.ts`). */
function unapprovedOf(metadata: unknown): { at: string } | null {
  const held = (metadata as { unapproved?: { at?: unknown } } | null)?.unapproved;
  return typeof held?.at === 'string' ? { at: held.at } : null;
}

/** The verification a run stamped on its row, or `null` where it stamped none it could name. */
function recordedVerificationOf(metadata: unknown): RecordedVerification | null {
  const value = (metadata as { verification?: unknown } | null)?.verification;
  return (RECORDED_VERIFICATIONS as readonly unknown[]).includes(value)
    ? (value as RecordedVerification)
    : null;
}

export async function productionOf(
  projectId: string,
  current: string | null,
): Promise<ReleaseProduction> {
  const read = await readReleasePath(projectId);
  if (!read.ok) return { ok: false, reason: read.reason };
  const prod = read.path.production;
  return {
    ok: true,
    name: prod?.name ?? null,
    url: prod?.declaration.url ?? null,
    serving: current,
  };
}

/** The branch production deploys from, as the project document declares it; null where it declares no production. */
async function deploysFromOf(projectId: string): Promise<string | null> {
  const read = await readReleasePath(projectId);
  return read.ok ? (read.path.production?.declaration.deploysFrom ?? null) : null;
}

export async function sharedFor(
  projectId: string,
  parts: readonly Part[],
  viewer: ViewerFacts | null,
  current: string | null,
  required: boolean,
  attemptRunIds: readonly string[] = [],
): Promise<Shared> {
  const [facts, approvers, admins, language, channels, changeRequestLinks, doc] = await Promise.all(
    [
      loadReleaseFacts(
        projectId,
        parts.flatMap((p) => p.issueIds),
        [...new Set([...parts.flatMap((p) => (p.runId ? [p.runId] : [])), ...attemptRunIds])],
      ),
      namedHolders('releases.approve', projectId),
      holderNames('project.admin', projectId),
      readContentLanguage(projectId),
      resolveReleaseChannels(projectId),
      readChangeRequestLinks(
        projectId,
        parts.flatMap((p) => p.issueIds),
      ),
      readProjectDocument(projectId),
    ],
  );
  return {
    projectId,
    ownerDeploys: releaseThroughChangeRequests(doc?.document),
    current,
    required,
    viewer,
    approvers,
    admins,
    policy: await readOwedPolicy(projectId),
    facts,
    contentLanguage: language.contentLanguage,
    provider: productionProviderOf(channels),
    changeRequestLinks,
  };
}

/**
 * Each run that went out, placed from its columns and the keys its place reads (`PLACING_KEYS` in
 * `pipeline/release-runs.ts`), and nothing more: a read that shows the newest few places every run
 * and reads the whole of only those (`weighWentOut`, ISS-1070). A run that went out reads its state
 * from its own stamp, never from its approvals, so none are read to place it.
 */
export async function wentOutParts(projectId: string): Promise<Part[]> {
  const [runs, deploysFrom] = await Promise.all([
    versionRuns(projectId, undefined, { placing: true }),
    deploysFromOf(projectId),
  ]);
  return runs
    .filter((r) => r.releasedAt !== null)
    .map((run) => runPart(run, [], [], false, deploysFrom));
}

/** The parts `wentOutParts` placed, each read whole with its attempts and approvals, keeping its place. */
export async function weighWentOut(
  projectId: string,
  placed: readonly Part[],
  required: boolean,
): Promise<Part[]> {
  const ids = placed.flatMap((p) => (p.runId ? [p.runId] : []));
  const [runs, deploysFrom, attempts, rows] = await Promise.all([
    releaseRunsByIds(projectId, ids),
    deploysFromOf(projectId),
    attemptsOf(ids),
    approvalsOfRuns(ids),
  ]);
  const approvals = await approvalViews(rows);
  const byId = new Map(runs.map((r) => [r.id, r]));
  return placed.map((p) => {
    const run = p.runId ? byId.get(p.runId) : undefined;
    if (!run) throw new Error(`release ${p.version}: its run ${p.runId} was placed and is gone`);
    return {
      ...runPart(
        run,
        attempts.filter((a) => a.runId === run.id),
        approvals.filter((a) => a.runId === run.id),
        required,
        deploysFrom,
      ),
      continuedAs: p.continuedAs,
    };
  });
}

export async function runParts(projectId: string, version: string | undefined, required: boolean) {
  const [runs, deploysFrom] = await Promise.all([
    versionRuns(projectId, version),
    deploysFromOf(projectId),
  ]);
  const ids = runs.map((r) => r.id);
  const [attempts, rows] = await Promise.all([attemptsOf(ids), approvalsOfRuns(ids)]);
  const approvals = await approvalViews(rows);
  return runs.map((run) =>
    runPart(
      run,
      attempts.filter((a) => a.runId === run.id),
      approvals.filter((a) => a.runId === run.id),
      required,
      deploysFrom,
    ),
  );
}

const REWORKED: IssueLandingReading = {
  kind: 'unclassified',
  why: 'it was reopened after this release claimed it, so its mark now names a later round',
  paths: [],
  source: null,
};

export async function readRelease(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseDetail> {
  return (await readReleaseRecord(projectId, version, viewer)).detail;
}

/** One release's record, and every criterion it counts as it weighed them (`weighedOf`): what its
 *  page lists, so the page never weighs a criterion a second time (ISS-1001). */
export interface ReleaseRecord {
  detail: ReleaseDetail;
  weighed: WeighedIssue[];
}

export async function readReleaseRecord(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseRecord> {
  if (!parseReleaseVersion(version)) {
    throw refuseRelease(
      'RELEASE_VERSION_SHAPE',
      `${JSON.stringify(version)} is not a release version: ${RELEASE_VERSION_SHAPE}`,
    );
  }
  const [required, current] = await Promise.all([
    approvalRequired(projectId),
    currentReleaseVersion(projectId),
  ]);
  const [runs, lineage] = await Promise.all([
    runParts(projectId, version, required),
    readLineage(projectId),
  ]);
  const run = runs[0];
  // An ended run that shipped nothing may be re-cut at its own version by the draft.
  const ended = !run || run.state === 'aborted' || run.state === 'failed';
  const draft = ended ? await draftPart(projectId) : null;
  const lines = releaseLinesOf(lineage);
  const placed = placeParts(lines, run ? [run] : [], draft);
  const part = placed.parts.find((p) => p.version === version);
  if (!part) {
    throw notFound(`project ${projectId} has cut no version ${version}`);
  }
  const [shared, read] = await Promise.all([
    sharedFor(
      projectId,
      [part],
      viewer,
      current,
      required,
      placed.groupOf(part).map((r) => r.id),
    ),
    readReleasePath(projectId),
  ]);
  await fillCuts(projectId, [part], placed.groupOf, shared.facts.cutters);
  const reworked = reworkedIn(part, shared.facts);
  const landings = await readLandingReadings(
    projectId,
    part.issueIds.flatMap((id) => {
      const i = shared.facts.issues.get(id);
      return i && !reworked.includes(id)
        ? [
            {
              id,
              marked: i.merged.at !== null,
              landing: i.merged.landing,
              artifacts: i.merged.artifacts,
              commitSha: i.merged.commitSha,
              readPaths: i.merged.readPaths,
            },
          ]
        : [];
    }),
  );
  for (const id of reworked) landings.set(id, REWORKED);
  const prod = read.ok ? read.path.production : null;
  const verifiedBy = await releaseVerifiedBy(projectId, part.verification);
  const feedbackAnswered = await feedbackAnsweredBy(
    projectId,
    part.issueIds,
    // a landing closed its issues and told who asked as a shipped release does (`run-records.ts`)
    { runId: part.runId, shipped: part.state === 'shipped' || part.state === 'landed' },
    viewer?.agency ?? 'human',
  );
  const keyOf = (id: string) => shared.facts.issues.get(id)?.key ?? id;
  const promotion =
    part.state === 'draft'
      ? await draftPromotionViewOf(projectId, part.issueIds, keyOf)
      : await promotionViewOf(part.runId, keyOf);
  // a draft keeps none; a cut release the corrections its own run keeps
  const corrections = await correctionViews(projectId, part === run ? run.corrections : []);
  const detail = {
    ...detailOf(
      part,
      shared,
      prod ? { name: prod.name, url: prod.declaration.url ?? null } : null,
      landings,
      feedbackAnswered,
      verifiedBy,
      promotion,
    ),
    corrections,
  };
  return { detail, weighed: weighedOf(part, shared) };
}
