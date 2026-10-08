import type {
  ReleaseDetail,
  ReleaseListResponse,
  ReleaseProduction,
} from '@forge/contracts/releases';
import { RELEASE_ATTENTION_GROUPS } from '@forge/contracts/releases';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { feedbackAnsweredBy } from '../feedback/index.js';
import { notFound } from '../middleware/route-errors.js';
import { holderNames, namedHolders } from '../permissions/index.js';
import type { ReleaseRunRow } from '../pipeline/index.js';
import { approvalRequired, readContentLanguage, readReleasePath } from '../project-config/index.js';
import { type ApprovalView, approvalsOfRuns, approvalViews } from './approvals.js';
import { collectReleaseBlockers } from './blockers.js';
import {
  productionProviderOf,
  type RecordedVerification,
  releaseVerifiedBy,
  resolveReleaseChannels,
} from './channel.js';
import { readFinishRecord } from './finish-record.js';
import { readLandingReadings } from './landing-surfaces.js';
import { RECORDED_VERIFICATIONS } from './plan.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';
import { continuationOf, fillCuts, type ReleaseLines, releaseLinesOf } from './release-cuts.js';
import { loadReleaseFacts } from './release-facts.js';
import { gateViews } from './release-gates.js';
import { detailOf, type Part, type Shared, summaryOf } from './release-read-views.js';
import type { ViewerFacts } from './release-view.js';
import { formatReleaseVersion, parseReleaseVersion, RELEASE_VERSION_SHAPE } from './version.js';
import type { LineageRun, VersionDecision } from './version-rule.js';
import { currentReleaseVersion, decideRosterVersion, readLineage } from './version-store.js';
import { attemptsOf, issueIdsOf, versionRuns, versionStatus } from './versions.js';

/**
 * The version a decision hands the draft. An undecided re-cut shows the version in question, and its
 * gate (`RELEASE_VERSION_UNDECIDED`) says why it cannot be cut yet; a line the rule refuses shows the
 * number it would have been, refused by its own gate at the cut.
 */
function draftVersionOf(d: VersionDecision): string {
  return d.kind === 'exhausted' || d.kind === 'behind' ? formatReleaseVersion(d.next) : d.version;
}

/** The number the next cut takes: the version rule asked about the roster waiting at the gate. */
export async function nextDraftVersion(projectId: string): Promise<string> {
  return draftVersionOf(await decideRosterVersion(projectId, await waitingIssueIds(projectId)));
}

interface DraftPart {
  part: Part;
  /** The attempt the next cut re-cuts, where it re-cuts one. */
  recutOf: string | null;
}

async function draftPart(projectId: string): Promise<DraftPart | null> {
  const ids = await waitingIssueIds(projectId);
  if (ids.length === 0) return null;
  const [decision, report, admins] = await Promise.all([
    decideRosterVersion(projectId, ids),
    collectReleaseBlockers(projectId, { issueIds: ids, door: 'batch' }),
    holderNames('project.admin', projectId),
  ]);
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
      gates: gateViews(report.blockers, report.warnings, admins),
      verification: null,
      commit: null,
      cuts: [],
      continuedAs: null,
    },
  };
}

/**
 * Which release each part belongs to, and the attempts each shows (`release-cuts.ts`). A version
 * whose roster went on under another version reads `continuedAs` and lists no attempts of its own;
 * the draft takes the attempts of the release it re-cuts, and that release's versions fold into it.
 */
function placeParts(
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

/** The commit a finished release's probes verified; an attempt still in flight claims one only. */
function finishedCommit(metadata: unknown): string | null {
  const finish = readFinishRecord(metadata);
  return finish?.state === 'finished' ? finish.commit : null;
}

function runPart(
  run: ReleaseRunRow,
  attempts: ReleaseAttemptRow[],
  approvals: ApprovalView[],
  required: boolean,
): Part {
  return {
    version: run.version,
    runId: run.id,
    state: versionStatus(run, approvals[0] ?? null, required),
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
  };
}

/** The verification a run stamped on its row, or `null` where it stamped none it could name. */
function recordedVerificationOf(metadata: unknown): RecordedVerification | null {
  const value = (metadata as { verification?: unknown } | null)?.verification;
  return (RECORDED_VERIFICATIONS as readonly unknown[]).includes(value)
    ? (value as RecordedVerification)
    : null;
}

async function productionOf(projectId: string, current: string | null): Promise<ReleaseProduction> {
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

async function sharedFor(
  projectId: string,
  parts: readonly Part[],
  viewer: ViewerFacts | null,
  current: string | null,
  required: boolean,
  attemptRunIds: readonly string[] = [],
): Promise<Shared> {
  const [facts, approvers, admins, language, channels] = await Promise.all([
    loadReleaseFacts(
      projectId,
      parts.flatMap((p) => p.issueIds),
      [...new Set([...parts.flatMap((p) => (p.runId ? [p.runId] : [])), ...attemptRunIds])],
    ),
    namedHolders('releases.approve', projectId),
    holderNames('project.admin', projectId),
    readContentLanguage(projectId),
    resolveReleaseChannels(projectId),
  ]);
  return {
    current,
    required,
    viewer,
    approvers,
    admins,
    facts,
    contentLanguage: language.contentLanguage,
    provider: productionProviderOf(channels),
  };
}

async function runParts(projectId: string, version: string | undefined, required: boolean) {
  const runs = await versionRuns(projectId, version);
  const ids = runs.map((r) => r.id);
  const [attempts, rows] = await Promise.all([attemptsOf(ids), approvalsOfRuns(ids)]);
  const approvals = await approvalViews(rows);
  return runs.map((run) =>
    runPart(
      run,
      attempts.filter((a) => a.runId === run.id),
      approvals.filter((a) => a.runId === run.id),
      required,
    ),
  );
}

export async function listReleases(
  projectId: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseListResponse> {
  const [required, current] = await Promise.all([
    approvalRequired(projectId),
    currentReleaseVersion(projectId),
  ]);
  const [runs, draft, production, lineage] = await Promise.all([
    runParts(projectId, undefined, required),
    draftPart(projectId),
    productionOf(projectId, current),
    readLineage(projectId),
  ]);
  const lines = releaseLinesOf(lineage);
  const placed = placeParts(lines, runs, draft);
  // A release is listed once, under the version its last attempt wears: a version its roster went on
  // from is one of that release's attempts, not a release of its own (ADR 0011).
  const parts = placed.parts.filter((p) => p.continuedAs === null);
  const shared = await sharedFor(
    projectId,
    parts,
    viewer,
    current,
    required,
    parts.flatMap((p) => placed.groupOf(p).map((r) => r.id)),
  );
  await fillCuts(projectId, parts, placed.groupOf, shared.facts.cutters);
  const releases = parts.map((p) => summaryOf(p, shared));
  const counts = Object.fromEntries(
    RELEASE_ATTENTION_GROUPS.map((a) => [a, releases.filter((r) => r.attentionGroup === a).length]),
  ) as ReleaseListResponse['counts'];
  return { releases, counts, approvalRequired: required, production };
}

export async function readRelease(
  projectId: string,
  version: string,
  viewer: ViewerFacts | null,
): Promise<ReleaseDetail> {
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
  const landings = await readLandingReadings(
    projectId,
    part.issueIds.flatMap((id) => {
      const i = shared.facts.issues.get(id);
      return i
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
  const prod = read.ok ? read.path.production : null;
  const verifiedBy = await releaseVerifiedBy(projectId, part.verification);
  const feedbackAnswered = await feedbackAnsweredBy(
    projectId,
    part.issueIds,
    { runId: part.runId, shipped: part.state === 'shipped' },
    viewer?.agency ?? 'human',
  );
  return detailOf(
    part,
    shared,
    prod ? { name: prod.name, url: prod.declaration.url ?? null } : null,
    landings,
    feedbackAnswered,
    verifiedBy,
  );
}
