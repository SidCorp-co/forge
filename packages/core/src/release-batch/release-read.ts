import type {
  ReleaseDetail,
  ReleaseListResponse,
  ReleaseProduction,
} from '@forge/contracts/releases';
import { RELEASE_ATTENTION_GROUPS } from '@forge/contracts/releases';
import { db } from '../db/client.js';
import type { ReleaseAttemptRow } from '../db/schema-release-ledger.js';
import { feedbackAnsweredBy } from '../feedback/index.js';
import { getIntegration } from '../integrations/index.js';
import { isRefusal } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import type { ReleaseRunRow } from '../pipeline/index.js';
import { approvalRequired, readContentLanguage, readReleasePath } from '../project-config/index.js';
import { type ApprovalView, approvalsOfRuns, approvalViews } from './approvals.js';
import { collectReleaseBlockers } from './blockers.js';
import { closeVerification, type RecordedVerification, resolveReleaseChannels } from './channel.js';
import { readLandingReadings } from './landing-surfaces.js';
import { RECORDED_VERIFICATIONS } from './plan.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';
import { approversOf, loadReleaseFacts } from './release-facts.js';
import { gateViews } from './release-gates.js';
import { detailOf, type Part, type Shared, summaryOf } from './release-read-views.js';
import type { ViewerFacts } from './release-view.js';
import {
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  RELEASE_VERSION_SHAPE,
} from './version.js';
import { currentReleaseVersion, highestSpentVersion, releaseLineOf } from './version-store.js';
import { attemptsOf, issueIdsOf, versionRuns, versionStatus } from './versions.js';

/** The number the next cut takes: one past the highest any batch spent, on the project's line. */
export async function nextDraftVersion(projectId: string): Promise<string> {
  const [highest, line] = await Promise.all([
    highestSpentVersion(db, projectId),
    releaseLineOf(projectId),
  ]);
  return formatReleaseVersion(nextReleaseVersion(highest?.version ?? null, line));
}

async function draftPart(projectId: string): Promise<Part | null> {
  const ids = await waitingIssueIds(projectId);
  if (ids.length === 0) return null;
  const [version, report] = await Promise.all([
    nextDraftVersion(projectId),
    collectReleaseBlockers(projectId, { issueIds: ids, door: 'batch' }),
  ]);
  return {
    version,
    runId: null,
    state: 'draft',
    issueIds: ids,
    openedAt: null,
    releasedAt: null,
    attempts: [],
    approvals: [],
    gates: gateViews(report.blockers, report.warnings),
    verification: null,
  };
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
  };
}

/** The verification a run stamped on its row, or `null` where it stamped none it could name. */
function recordedVerificationOf(metadata: unknown): RecordedVerification | null {
  const value = (metadata as { verification?: unknown } | null)?.verification;
  return (RECORDED_VERIFICATIONS as readonly unknown[]).includes(value)
    ? (value as RecordedVerification)
    : null;
}

/**
 * How this release is proved, and through which provider: as its run recorded it, else as the
 * project declares it now. `null` where neither names one: no production binding, or a probe
 * declaration a release would refuse.
 */
async function verifiedByOf(projectId: string, part: Part): Promise<ReleaseDetail['verifiedBy']> {
  const channels = await resolveReleaseChannels(projectId);
  const channel = channels[0];
  const provider = channel
    ? (getIntegration(channel.provider)?.presentation?.label ?? channel.provider)
    : null;
  if (part.verification) return { kind: part.verification, provider };
  if (!channel) return null;
  try {
    return { kind: closeVerification(channels).kind, provider };
  } catch (err) {
    if (isRefusal(err, 'RELEASE_PROBES_UNREADABLE')) return null;
    throw err;
  }
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
): Promise<Shared> {
  const [facts, approvers, language] = await Promise.all([
    loadReleaseFacts(
      projectId,
      parts.flatMap((p) => p.issueIds),
      parts.flatMap((p) => (p.runId ? [p.runId] : [])),
    ),
    approversOf(projectId),
    readContentLanguage(projectId),
  ]);
  return {
    current,
    required,
    viewer,
    approvers,
    facts,
    contentLanguage: language.contentLanguage,
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
  const [runs, draft, production] = await Promise.all([
    runParts(projectId, undefined, required),
    draftPart(projectId),
    productionOf(projectId, current),
  ]);
  // The draft only ever wears a number no batch spent, so a run at its version handed that number back.
  const parts = draft ? [draft, ...runs.filter((r) => r.version !== draft.version)] : runs;
  const shared = await sharedFor(projectId, parts, viewer, current, required);
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
  const [run] = await runParts(projectId, version, required);
  // An ended run that shipped nothing may have handed its number back to the draft.
  const ended = !run || run.state === 'aborted' || run.state === 'failed';
  const draft = ended ? await draftPart(projectId) : null;
  const part = draft?.version === version ? draft : run;
  if (!part || part.version !== version) {
    throw notFound(`project ${projectId} has cut no version ${version}`);
  }
  const [shared, read] = await Promise.all([
    sharedFor(projectId, [part], viewer, current, required),
    readReleasePath(projectId),
  ]);
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
  const verifiedBy = await verifiedByOf(projectId, part);
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
