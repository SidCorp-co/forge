// Every reason a release will not start, enumerated once and read by every door.
//
// Before ISS-1127 there were two lists. `readiness.ts` computed `gaps` from the
// declarations for a human to read; `createReleaseBatch` refused on its own
// checks in its own order; `recorded.ts` refused on a third set. None named the
// others, so clearing one list predicted nothing about the next, and an operator
// learnt the reasons one at a time — each only after clearing the one before it.
//
// Three properties hold here and are what the callers rely on:
//
//   - It never throws. A check that cannot be evaluated becomes an answer of
//     its own, in the position that check held. A reason that cannot be read
//     is not the same as a reason that is absent.
//
//   - It makes no outbound request. `readLiveCommit` stays in the create path,
//     and what is checked here is the probe DECLARATION.
//
//   - It reports in the order the doors refuse in, and a door throws the FIRST
//     blocker under its existing name, so no caller meets a different code than
//     it does today for the same state.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues } from '../db/schema.js';
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
import { readProjectBranches } from '../projects/service.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import {
  blockerHttpStatus,
  type CollectReleaseBlockersOptions,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlockedError,
  type ReleaseBlocker,
  type ReleaseBlockerCode,
  type ReleaseBlockerReport,
  type ReleaseDoor,
  type ReleaseWarning,
  releaseBlockerSentence,
} from './blocker-sentences.js';
import {
  projectRunnerDeviceIds,
  type ReleaseChannel,
  ReleaseRunnerAmbiguousError,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
} from './channel.js';
import {
  BatchInFlightError,
  ClaimConflictError,
  NoReleaseGateError,
  NoRunnerOnlineError,
  ReleaseMultiChannelUnsupportedError,
  ReleasePoolEmptyError,
  ReleaseProbesUndeclaredError,
  ReleaseRecordMissingError,
  ReleaseRunnerUndeclaredError,
  ReleaseWorkUnmergedError,
} from './errors.js';
import {
  RELEASE_GATE_STATUS,
  ReleaseTargetUndeclaredError,
  resolveReleaseDeclaration,
} from './gate.js';
import { ReleaseBranchesUndeclaredError, releaseBranches } from './plan.js';
import { getActiveReleaseBatch } from './queries.js';
import { invalidProbeUrls } from './verify.js';

export * from './blocker-sentences.js';

function blocker(
  code: ReleaseBlockerCode,
  details?: Record<string, unknown>,
  scope?: 'roster',
): ReleaseBlocker {
  return {
    code,
    httpStatus: blockerHttpStatus(code),
    message: releaseBlockerSentence(code, details),
    evaluated: code !== 'RELEASE_CHECK_UNEVALUATED',
    ...(details ? { details } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** One check, and the blocker that stands in for it when it cannot be run. */
async function evaluate<T>(
  check: string,
  read: () => Promise<T>,
  out: ReleaseBlocker[],
): Promise<T | undefined> {
  const { value, failure } = await attempt(check, read);
  if (failure) out.push(failure);
  return value;
}

/** The same read, with its failure handed back rather than appended. */
async function attempt<T>(
  check: string,
  read: () => Promise<T>,
): Promise<{ value: T | undefined; failure: ReleaseBlocker | null }> {
  try {
    return { value: await read(), failure: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { value: undefined, failure: blocker('RELEASE_CHECK_UNEVALUATED', { check, detail }) };
  }
}

/** The issues this call is about: the caller's list, or the whole roster. */
async function resolveRoster(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[] | undefined,
  out: ReleaseBlocker[],
): Promise<string[] | undefined> {
  if (issueIds) return issueIds;
  const rows = await evaluate(
    'roster',
    async () =>
      await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.projectId, projectId), eq(issues.status, gateStatus))),
    out,
  );
  if (!rows) return undefined;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) out.push(blocker('RELEASE_ROSTER_EMPTY', undefined, 'roster'));
  else if (ids.length > RELEASE_ROSTER_LIMIT) {
    out.push(
      blocker(
        'RELEASE_ROSTER_OVERSIZE',
        { waiting: ids.length, limit: RELEASE_ROSTER_LIMIT },
        'roster',
      ),
    );
  }
  return ids;
}

/** Wrong status, wrong project, already claimed — the caller's own list only. */
async function claimBlockers(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[],
  out: ReleaseBlocker[],
): Promise<void> {
  const rows = await evaluate(
    'claim',
    async () =>
      await db
        .select({ id: issues.id, status: issues.status, claimed: issues.releaseBatchRunId })
        .from(issues)
        .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds))),
    out,
  );
  if (!rows) return;
  const found = new Set(rows.map((r) => r.id));
  const wrong = [
    ...issueIds.filter((id) => !found.has(id)),
    ...rows.filter((r) => r.status !== gateStatus || r.claimed !== null).map((r) => r.id),
  ];
  if (wrong.length > 0) out.push(blocker('CLAIM_CONFLICT', { issueIds: [...new Set(wrong)] }));
}

/** What the roster owes before it may be closed: a note, and a merge. */
async function rosterBlockers(
  door: ReleaseDoor,
  issueIds: string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const unrecorded = await evaluate(
    'release-record',
    async () => await issuesMissingReleaseRecord(issueIds),
    out,
  );
  if (unrecorded && unrecorded.length > 0) {
    out.push(blocker('RELEASE_RECORD_MISSING', { issueIds: unrecorded }));
  }
  if (door !== 'record') return;
  const rows = await evaluate(
    'merged',
    async () =>
      await db
        .select({ id: issues.id, mergedAt: issues.mergedAt })
        .from(issues)
        .where(inArray(issues.id, issueIds)),
    out,
  );
  if (!rows) return;
  const unmerged = rows.filter((r) => r.mergedAt === null).map((r) => r.id);
  if (unmerged.length > 0) out.push(blocker('RELEASE_WORK_UNMERGED', { issueIds: unmerged }));
}

/** The label, the probes, and how many live bindings one reading would answer for. */
function channelBlockers(
  projectId: string,
  channels: ReleaseChannel[],
  door: ReleaseDoor,
  out: ReleaseBlocker[],
): string | null {
  let label: string | null = null;
  // `soleVerifyConfig` checks the channel COUNT before the probes; the batch
  // path checks it last. Each door keeps its own order (ISS-1127).
  if (door === 'record' && channels.length > 1) {
    out.push(blocker('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: channels.length }));
  }
  try {
    label = releaseRunnerLabelOf(projectId, channels);
    if (door === 'batch' && !label) out.push(blocker('RELEASE_RUNNER_UNDECLARED'));
  } catch (err) {
    const labels = err instanceof ReleaseRunnerAmbiguousError ? err.labels : [];
    out.push(blocker('RELEASE_RUNNER_AMBIGUOUS', { labels }));
  }
  if (channels.some((c) => !c.verify)) out.push(blocker('RELEASE_PROBES_UNDECLARED'));
  return label;
}

/** Which boxes could take this release, and whether the declared one is among them. */
async function poolBlockers(
  projectId: string,
  label: string | null,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
): Promise<void> {
  const pool = await evaluate(
    'runner-pool',
    async () => {
      const labelled = label ? await resolveReleaseDeviceIds(projectId, label) : [];
      const preferred =
        labelled.length === 0
          ? []
          : await onlineCapableDeviceIds(projectId, {}, { allowDeviceIds: labelled });
      const eligible =
        preferred.length > 0 ? preferred : await onlineCapableDeviceIds(projectId, {});
      return {
        preferenceMet: preferred.length > 0,
        eligible,
        fleet: await projectRunnerDeviceIds(projectId),
      };
    },
    out,
  );
  if (!pool) return;
  if (pool.eligible.length === 0) {
    out.push(blocker(pool.fleet.length === 0 ? 'RELEASE_POOL_EMPTY' : 'NO_RUNNER_ONLINE'));
    return;
  }
  // ISS-1128 made the label rank the pool rather than filter it, so an unmet
  // preference is no longer a reason a release will not start. It is still a
  // fact the operator is owed in the same answer, which is what a warning is.
  if (label && !pool.preferenceMet) {
    warnings.push({
      code: 'RELEASE_RUNNER_PREFERENCE_UNMET',
      message: `No box on this project carries the declared release label \`${label}\`, so this release goes to the pool this project has. Label the box that holds the deploy credential, or withdraw the label by sending it as \`null\`.`,
      details: { label, eligible: pool.eligible.length },
    });
  }
}

/**
 * A probe url no request could be made to.
 *
 * Reported where the LIVE READ stands — last on a batch, after the roster on a
 * record — because that read is where this state fails. Any earlier and it
 * displaces a refusal the caller already gets for the same project.
 */
function unreadableProbeBlockers(channels: ReleaseChannel[], out: ReleaseBlocker[]): void {
  const urls = channels.flatMap((c) => (c.verify ? invalidProbeUrls(c.verify) : []));
  if (urls.length > 0) out.push(blocker('RELEASE_PROBES_UNREADABLE', { urls }));
}

/** Is there a branch a release could promote from. */
async function branchBlockers(projectId: string, out: ReleaseBlocker[]): Promise<void> {
  const branches = await evaluate(
    'branches',
    async () => await readProjectBranches(projectId),
    out,
  );
  if (branches === undefined) return;
  try {
    releaseBranches(
      branches ?? { baseBranch: null, liveBranch: null },
      branches?.releaseModel ?? 'none',
    );
  } catch {
    out.push(blocker('RELEASE_BRANCHES_UNDECLARED'));
  }
}

/**
 * Every reason this project's release will not start, in the order the doors
 * refuse in. Never throws, and reaches no network.
 */
export async function collectReleaseBlockers(
  projectId: string,
  options: CollectReleaseBlockersOptions = {},
): Promise<ReleaseBlockerReport> {
  const door = options.door ?? 'batch';
  const blockers: ReleaseBlocker[] = [];
  const warnings: ReleaseWarning[] = [];

  const read = await evaluate(
    'declaration',
    async () => await resolveReleaseDeclaration(projectId),
    blockers,
  );
  if (read === undefined) {
    return {
      projectId,
      projectExists: true,
      declaration: null,
      channels: null,
      blockers,
      warnings,
    };
  }
  if (read === null) {
    return {
      projectId,
      projectExists: false,
      declaration: null,
      channels: null,
      blockers,
      warnings,
    };
  }
  if (read.kind === 'no-release') blockers.push(blocker('NO_RELEASE_GATE'));
  if (read.kind === 'undeclared-target') {
    blockers.push(blocker('RELEASE_TARGET_UNDECLARED', { releaseModel: read.releaseModel }));
  }

  if (read.kind !== 'gated') {
    return { projectId, projectExists: true, declaration: read, channels: [], blockers, warnings };
  }

  // Both groups are READ here and REPORTED in the order the door refuses in.
  // A channel read that failed must not outrank a roster reason the batch door
  // reached first, or a 409 an operator already knows becomes a 503.
  const ch = await attempt('channels', async () => await resolveReleaseChannels(projectId));
  const channels = ch.value ?? null;

  const roster: ReleaseBlocker[] = [];
  const found = await resolveRoster(projectId, RELEASE_GATE_STATUS, options.issueIds, roster);
  if (options.issueIds && options.issueIds.length > 0) {
    await claimBlockers(projectId, RELEASE_GATE_STATUS, options.issueIds, roster);
  }
  await rosterBlockers(door, found ?? [], roster);

  const machinery: ReleaseBlocker[] = [];
  if (ch.failure) machinery.push(ch.failure);
  if (channels) {
    const label = channelBlockers(projectId, channels, door, machinery);
    if (door === 'batch') {
      await poolBlockers(projectId, label, machinery, warnings);
      await branchBlockers(projectId, machinery);
      if (channels.length > 1) {
        machinery.push(blocker('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: channels.length }));
      }
      unreadableProbeBlockers(channels, machinery);
    }
  } else if (door === 'batch') {
    await poolBlockers(projectId, null, machinery, warnings);
    await branchBlockers(projectId, machinery);
  }

  blockers.push(...(door === 'batch' ? [...roster, ...machinery] : [...machinery, ...roster]));
  if (door === 'record' && channels) unreadableProbeBlockers(channels, blockers);

  if (door === 'batch') {
    const active = await evaluate(
      'in-flight',
      async () => await getActiveReleaseBatch(projectId),
      blockers,
    );
    if (active) blockers.push(blocker('BATCH_IN_FLIGHT', { runId: active.runId }));
  }

  return { projectId, projectExists: true, declaration: read, channels, blockers, warnings };
}

/**
 * The error the first blocker is thrown as, carrying the whole list.
 *
 * The class, the code and the wording are the ones that door already used, so
 * nothing's `instanceof` and no operator's vocabulary moves. What rides along
 * is every other reason standing at the same moment — which is the issue.
 */
export function releaseBlockerError(report: ReleaseBlockerReport): ReleaseBlockedError | null {
  const first = report.blockers[0];
  if (!first) return null;
  const ids = Array.isArray(first.details?.issueIds) ? (first.details.issueIds as string[]) : [];
  const err = errorFor(first, ids, report);
  const carried: ReleaseBlockedError = err;
  carried.releaseBlockers = report.blockers;
  return carried;
}

export class ReleaseCheckUnevaluatedError extends Error {
  constructor(public readonly check: string) {
    super(`RELEASE_CHECK_UNEVALUATED: ${check}`);
    this.name = 'ReleaseCheckUnevaluatedError';
  }
}

/** The probes declare a url no request could be made to. */
export class ReleaseProbesUnreadableError extends Error {
  constructor(public readonly urls: string[]) {
    super(`RELEASE_PROBES_UNREADABLE: ${urls.join(', ')}`);
    this.name = 'ReleaseProbesUnreadableError';
  }
}

/** The roster read for this project cannot be cut as one release. */
export class ReleaseRosterUnusableError extends Error {
  constructor(
    public readonly code: 'RELEASE_ROSTER_EMPTY' | 'RELEASE_ROSTER_OVERSIZE',
    public readonly waiting: number,
  ) {
    super(`${code}: ${waiting} issue(s) at the release gate`);
    this.name = 'ReleaseRosterUnusableError';
  }
}

function errorFor(
  first: ReleaseBlocker,
  ids: string[],
  report: ReleaseBlockerReport,
): ReleaseBlockedError {
  switch (first.code) {
    case 'NO_RELEASE_GATE':
      return new NoReleaseGateError();
    case 'RELEASE_TARGET_UNDECLARED':
      return new ReleaseTargetUndeclaredError(
        report.projectId,
        (first.details?.releaseModel as 'promote' | 'publish') ?? 'publish',
      );
    case 'CLAIM_CONFLICT':
      return new ClaimConflictError(ids);
    case 'RELEASE_ROSTER_EMPTY':
    case 'RELEASE_ROSTER_OVERSIZE':
      return new ReleaseRosterUnusableError(first.code, Number(first.details?.waiting ?? 0));
    case 'RELEASE_RECORD_MISSING':
      return new ReleaseRecordMissingError(ids);
    case 'RELEASE_WORK_UNMERGED':
      return new ReleaseWorkUnmergedError(ids);
    case 'RELEASE_RUNNER_AMBIGUOUS':
      return new ReleaseRunnerAmbiguousError(
        report.projectId,
        (first.details?.labels as string[]) ?? [],
      );
    case 'RELEASE_RUNNER_UNDECLARED':
      return new ReleaseRunnerUndeclaredError();
    case 'RELEASE_PROBES_UNDECLARED':
      return new ReleaseProbesUndeclaredError();
    case 'RELEASE_PROBES_UNREADABLE':
      return new ReleaseProbesUnreadableError((first.details?.urls as string[]) ?? []);
    case 'RELEASE_POOL_EMPTY':
      return new ReleasePoolEmptyError();
    case 'NO_RUNNER_ONLINE':
      return new NoRunnerOnlineError();
    case 'RELEASE_BRANCHES_UNDECLARED':
      return new ReleaseBranchesUndeclaredError();
    case 'RELEASE_MULTI_CHANNEL_UNSUPPORTED':
      return new ReleaseMultiChannelUnsupportedError(Number(first.details?.count ?? 0));
    case 'BATCH_IN_FLIGHT':
      return new BatchInFlightError(null);
    case 'RELEASE_CHECK_UNEVALUATED':
      return new ReleaseCheckUnevaluatedError(String(first.details?.check ?? 'unknown'));
  }
}
