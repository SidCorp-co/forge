// Every reason a release will not start, enumerated once and read by every door.
//
// Before ISS-1127 there were three lists — `readiness.ts`'s `gaps`,
// `createReleaseBatch`'s own checks, `recorded.ts`'s third set — none naming the
// others, so an operator learnt the reasons one at a time. Three properties the
// callers rely on: it never throws (a check that cannot be evaluated becomes an
// answer in the position that check held); it makes no outbound request, so what
// is checked here is the probe DECLARATION; and it reports in the order the doors
// refuse in, a door throwing the FIRST blocker under its existing name.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues } from '../db/schema.js';
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
import { readProjectBranches } from '../projects/service.js';
import { releaseIneligibleRunners } from '../runners/ineligible.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import { attempt, blocker, evaluate } from './blocker-kit.js';
import {
  type CollectReleaseBlockersOptions,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlocker,
  type ReleaseBlockerReport,
  type ReleaseDoor,
  type ReleaseWarning,
  runnerPreferenceUnmetSentence,
} from './blocker-sentences.js';
import {
  projectRunnerDeviceIds,
  type ReleaseChannel,
  ReleaseRunnerAmbiguousError,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
} from './channel.js';
import { criteriaHold } from './criteria-hold.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
import { releaseBranches } from './plan.js';
import { getActiveReleaseBatch } from './queries.js';
import { invalidProbeUrls } from './verify.js';

export * from './blocker-sentences.js';

/** One transition short of the gate, which `RELEASE_ROSTER_EMPTY` counts so its
 *  sentence names where the work stands. `transitions` admits `needs_info` and
 *  `on_hold` too, and both are parks rather than work on its way. */
const NEAR_GATE_STATUSES: readonly IssueStatus[] = ['testing', 'tested'];

/** How many issues stand one move short of the gate; undefined where the read failed. */
async function countNearGate(
  projectId: string,
  out: ReleaseBlocker[],
): Promise<number | undefined> {
  const rows = await evaluate(
    'near-gate',
    async () =>
      await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.projectId, projectId), inArray(issues.status, NEAR_GATE_STATUSES))),
    out,
  );
  return rows?.length;
}

interface RosterRead {
  ids: string[];
  /** The subset no release batch has claimed, which is what the sweep works on. */
  unclaimed: string[];
}

/** The issues this call is about: the caller's list, or the whole roster. */
async function resolveRoster(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[] | undefined,
  out: ReleaseBlocker[],
): Promise<RosterRead | undefined> {
  if (issueIds) return { ids: issueIds, unclaimed: issueIds };
  const rows = await evaluate(
    'roster',
    async () =>
      await db
        .select({ id: issues.id, claimed: issues.releaseBatchRunId })
        .from(issues)
        .where(and(eq(issues.projectId, projectId), eq(issues.status, gateStatus))),
    out,
  );
  if (!rows) return undefined;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) {
    const nearGate = await countNearGate(projectId, out);
    out.push(
      blocker('RELEASE_ROSTER_EMPTY', nearGate === undefined ? undefined : { nearGate }, 'roster'),
    );
  } else if (ids.length > RELEASE_ROSTER_LIMIT) {
    out.push(
      blocker(
        'RELEASE_ROSTER_OVERSIZE',
        { waiting: ids.length, limit: RELEASE_ROSTER_LIMIT },
        'roster',
      ),
    );
  }
  return { ids, unclaimed: rows.filter((r) => r.claimed === null).map((r) => r.id) };
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
    if (pool.fleet.length === 0) out.push(blocker('RELEASE_POOL_EMPTY'));
    else await heldFleetBlocker(projectId, out);
  }
  // ISS-1128 made the label rank the pool rather than filter it, so an unmet
  // preference is no longer a reason a release will not start. It is still a
  // fact the operator is owed in the same answer, which is what a warning is —
  // and owed WITH an empty pool, not instead of it: a box that is offline and a
  // box that is unlabelled are two things to fix, and this answer shows every
  // reason at once (ISS-1127).
  if (label && !pool.preferenceMet) {
    warnings.push({
      code: 'RELEASE_RUNNER_PREFERENCE_UNMET',
      message: runnerPreferenceUnmetSentence(label),
      details: { label, eligible: pool.eligible.length },
    });
  }
}

/**
 * Which boxes are held, and by what. Read in an `attempt` of its own so a
 * failure here leaves `NO_RUNNER_ONLINE` standing beside the unevaluated entry
 * rather than replacing a reason the operator can act on with one they cannot.
 */
async function heldFleetBlocker(projectId: string, out: ReleaseBlocker[]): Promise<void> {
  const holds = await attempt(
    'runner-holds',
    async () => await releaseIneligibleRunners(projectId),
  );
  out.push(blocker('NO_RUNNER_ONLINE', { runners: holds.value ?? [] }));
  if (holds.failure) out.push(holds.failure);
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

  const decl = await attempt('declaration', async () => await resolveReleaseDeclaration(projectId));
  if (decl.failure) blockers.push(decl.failure);
  const read = decl.value;
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
  if (read) {
    if (read.kind === 'no-release') blockers.push(blocker('NO_RELEASE_GATE'));
    if (read.kind === 'undeclared-target') {
      blockers.push(blocker('RELEASE_TARGET_UNDECLARED', { releaseModel: read.releaseModel }));
    }
    if (read.kind !== 'gated') {
      return {
        projectId,
        projectExists: true,
        declaration: read,
        channels: [],
        blockers,
        warnings,
      };
    }
  }

  // `read === undefined` means the declaration THREW, and the checks below run
  // anyway: the declaration is a precondition for exactly the two reasons above
  // and for the judgement that the rest are moot, which cannot be made where it
  // cannot be read. Returning here instead reported one reason, and it was the
  // one reason the operator could not act on (ISS-1127).
  const channels = await gatedBlockers(projectId, door, options.issueIds, blockers, warnings);
  return {
    projectId,
    projectExists: true,
    declaration: read ?? null,
    channels,
    blockers,
    warnings,
  };
}

/** Everything a project WITH a release gate owes, and what a project whose gate
 *  could not be read is checked for all the same. Appends to `out`. */
async function gatedBlockers(
  projectId: string,
  door: ReleaseDoor,
  issueIds: string[] | undefined,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
): Promise<ReleaseChannel[] | null> {
  // Both groups are READ here and REPORTED in the order the door refuses in.
  // A channel read that failed must not outrank a roster reason the batch door
  // reached first, or a 409 an operator already knows becomes a 503.
  const ch = await attempt('channels', async () => await resolveReleaseChannels(projectId));
  const channels = ch.value ?? null;

  const roster: ReleaseBlocker[] = [];
  const found = await resolveRoster(projectId, RELEASE_GATE_STATUS, issueIds, roster);
  if (issueIds && issueIds.length > 0) {
    await claimBlockers(projectId, RELEASE_GATE_STATUS, issueIds, roster);
  }
  await rosterBlockers(door, found?.ids ?? [], roster);

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

  out.push(...(door === 'batch' ? [...roster, ...machinery] : [...machinery, ...roster]));
  if (door === 'record' && channels) unreadableProbeBlockers(channels, out);

  if (door === 'batch') {
    const active = await evaluate(
      'in-flight',
      async () => await getActiveReleaseBatch(projectId),
      out,
    );
    if (active) out.push(blocker('BATCH_IN_FLIGHT', { runId: active.runId }));
    if (!issueIds && found) await criteriaHold(projectId, found.unclaimed, out, warnings);
  }
  return channels;
}

export * from './blocker-errors.js';
export * from './blocker-kit.js';
