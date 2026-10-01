import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import {
  RELEASE_ATTEMPT_STAGES,
  type ReleaseAttemptRow,
  releaseAttempts,
} from '../db/schema-release-ledger.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { releaseNotesSections } from '../issues/release-notes.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { environmentsOf, readReleasePath } from '../project-config/release-path.js';
import { type ApprovalView, approvalRefusal, approvalsOfRuns, approvalViews } from './approvals.js';
import { collectReleaseBlockers } from './blockers.js';
import { type BoundsReading, readBounds } from './bounds.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { formatReleaseVersion, nextReleaseVersion, parseReleaseVersion } from './version.js';
import { currentReleaseVersion, highestCutVersion } from './version-store.js';

export const VERSION_STATUSES = [
  'in_progress',
  'awaiting_approval',
  'returned',
  'shipped',
  'rolled_back',
  'failed',
  'aborted',
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

interface RunRow {
  id: string;
  status: string;
  version: string;
  metadata: Record<string, unknown>;
  startedAt: Date;
  releasedAt: Date | null;
}

async function versionRuns(projectId: string, version?: string): Promise<RunRow[]> {
  const rows = await db
    .select({
      id: pipelineRuns.id,
      status: pipelineRuns.status,
      version: pipelineRuns.releaseVersion,
      metadata: pipelineRuns.metadata,
      startedAt: pipelineRuns.startedAt,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.projectId, projectId),
        sql`${pipelineRuns.releaseVersion} IS NOT NULL`,
        sql`${pipelineRuns.metadata}->>'source' = 'release-batch'`,
        ...(version ? [eq(pipelineRuns.releaseVersion, version)] : []),
      ),
    )
    .orderBy(sql`string_to_array(${pipelineRuns.releaseVersion}, '.')::int[] DESC`);
  return rows.map((r) => ({
    ...r,
    version: r.version as string,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

async function attemptsOf(runIds: readonly string[]): Promise<ReleaseAttemptRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(releaseAttempts)
    .where(inArray(releaseAttempts.runId, [...runIds]))
    .orderBy(asc(releaseAttempts.startedAt), asc(releaseAttempts.id));
}

const issueIdsOf = (meta: Record<string, unknown>): string[] =>
  Array.isArray(meta.issueIds)
    ? meta.issueIds.filter((x): x is string => typeof x === 'string')
    : [];

// cm:why a version's status is read from what the run recorded, in this order: a ship stamp is final, an open run is waiting on its approval or still at work, and a concluded run that repaired was rolled back
export function versionStatus(
  run: Pick<RunRow, 'status' | 'releasedAt' | 'metadata'>,
  attempts: readonly Pick<ReleaseAttemptRow, 'stage' | 'settledAt'>[],
  latest: Pick<ApprovalView, 'decision'> | null,
): VersionStatus {
  if (run.releasedAt) return 'shipped';
  if (run.status === 'running' || run.status === 'paused') {
    if (latest && latest.decision === null) return 'awaiting_approval';
    if (latest?.decision === 'returned') return 'returned';
    return 'in_progress';
  }
  if (attempts.some((a) => a.stage === 'repair' && a.settledAt !== null)) return 'rolled_back';
  if (run.metadata.abort) return 'aborted';
  return 'failed';
}

function stagesOf(attempts: readonly ReleaseAttemptRow[]) {
  return RELEASE_ATTEMPT_STAGES.flatMap((stage) => {
    const last = attempts.filter((a) => a.stage === stage).at(-1);
    return last ? [{ stage, verdict: last.verdict, settled: last.settledAt !== null }] : [];
  });
}

function rowOf(
  run: RunRow,
  attempts: readonly ReleaseAttemptRow[],
  approvals: readonly ApprovalView[],
  current: string | null,
) {
  const latest = approvals[0] ?? null;
  return {
    version: run.version,
    runId: run.id,
    runStatus: run.status,
    status: versionStatus(run, attempts, latest),
    current: current === run.version,
    openedAt: run.startedAt.toISOString(),
    releasedAt: run.releasedAt ? run.releasedAt.toISOString() : null,
    issueCount: issueIdsOf(run.metadata).length,
    approval: latest,
    stages: stagesOf(attempts),
  };
}

async function draftOf(projectId: string) {
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      releaseNotes: issues.releaseNotes,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, RELEASE_GATE_STATUS),
        isNull(issues.releaseBatchRunId),
      ),
    )
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`);
  if (rows.length === 0) return null;
  const [prefix, highest, report] = await Promise.all([
    activeIssuePrefix(projectId),
    highestCutVersion(db, projectId),
    collectReleaseBlockers(projectId, { issueIds: rows.map((r) => r.id), door: 'batch' }),
  ]);
  return {
    version: formatReleaseVersion(nextReleaseVersion(highest?.version ?? null, null)),
    issues: rows.map((r) => ({
      id: r.id,
      key: r.issSeq != null ? formatIssueRef(prefix, r.issSeq) : r.id,
      title: r.title ?? '(untitled)',
      section: r.releaseNotes?.section ?? null,
    })),
    blockers: report.blockers.map((b) => ({ code: b.code, message: b.message })),
  };
}

async function environmentsWith(projectId: string, current: string | null) {
  const read = await readReleasePath(projectId);
  if (!read.ok)
    return { environments: [], environmentsRead: { ok: false as const, reason: read.reason } };
  return {
    environments: environmentsOf(read.path.document).map((e) => ({
      name: e.name,
      tier: e.declaration.tier,
      url: e.declaration.url ?? null,
      version: e.declaration.tier === 'production' ? current : null,
    })),
    environmentsRead: { ok: true as const },
  };
}

export async function listReleaseVersions(projectId: string) {
  const runs = await versionRuns(projectId);
  const ids = runs.map((r) => r.id);
  const [attempts, approvalRows, current, draft] = await Promise.all([
    attemptsOf(ids),
    approvalsOfRuns(ids),
    currentReleaseVersion(projectId),
    draftOf(projectId),
  ]);
  const approvals = await approvalViews(approvalRows);
  const versions = runs.map((run) =>
    rowOf(
      run,
      attempts.filter((a) => a.runId === run.id),
      approvals.filter((a) => a.runId === run.id),
      current,
    ),
  );
  const count = (pred: (v: (typeof versions)[number]) => boolean) => versions.filter(pred).length;
  return {
    versions,
    draft,
    counts: {
      all: versions.length,
      awaitingApproval: count((v) => v.status === 'awaiting_approval'),
      live: count((v) => v.status === 'shipped'),
      rolledBack: count((v) => v.status === 'rolled_back'),
    },
    ...(await environmentsWith(projectId, current)),
  };
}

const CHANGELOG_SECTIONS = releaseNotesSections.filter((s) => s !== 'Skip');

async function changelogOf(projectId: string, issueIds: readonly string[]) {
  if (issueIds.length === 0) return { changelog: [], withoutNotes: [] };
  const [rows, prefix] = await Promise.all([
    db
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        releaseNotes: issues.releaseNotes,
      })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...issueIds])))
      .orderBy(asc(issues.issSeq)),
    activeIssuePrefix(projectId),
  ]);
  const key = (r: (typeof rows)[number]) =>
    r.issSeq != null ? formatIssueRef(prefix, r.issSeq) : r.id;
  return {
    changelog: CHANGELOG_SECTIONS.map((section) => ({
      section,
      entries: rows
        .filter((r) => r.releaseNotes?.section === section)
        .map((r) => ({
          issueId: r.id,
          key: key(r),
          userFacing: r.releaseNotes?.userFacing ?? '',
          technical: r.releaseNotes?.technical ?? null,
        })),
    })).filter((s) => s.entries.length > 0),
    withoutNotes: rows
      .filter((r) => !r.releaseNotes)
      .map((r) => ({ issueId: r.id, key: key(r), title: r.title ?? '(untitled)' })),
  };
}

export async function readReleaseVersion(projectId: string, version: string) {
  if (!parseReleaseVersion(version)) {
    throw approvalRefusal(
      422,
      'RELEASE_VERSION_SHAPE',
      `${JSON.stringify(version)} is not a release version: MAJOR.MINOR.PATCH, three dot-separated integers`,
    );
  }
  const [run] = await versionRuns(projectId, version);
  if (!run)
    throw approvalRefusal(404, 'NOT_FOUND', `project ${projectId} has cut no version ${version}`);
  const [attempts, approvalRows, current, read] = await Promise.all([
    attemptsOf([run.id]),
    approvalsOfRuns([run.id]),
    currentReleaseVersion(projectId),
    readReleasePath(projectId),
  ]);
  const approvals = await approvalViews(approvalRows);
  const bounds: BoundsReading = readBounds(attempts);
  return {
    ...rowOf(run, attempts, approvals, current),
    ...(await changelogOf(projectId, issueIdsOf(run.metadata))),
    attempts,
    bounds,
    approvals,
    environment: read.ok ? (read.path.production?.name ?? null) : null,
  };
}
