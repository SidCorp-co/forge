// Every reason a release will not start, enumerated once and read by every door (ISS-1127).
//
// Three properties the callers rely on: it never throws (a check that cannot be
// evaluated becomes an answer in the position that check held); it makes no outbound
// request, so what is checked here is the probe DECLARATION; and it reports in the order
// the doors refuse in, a door refusing with every blocker in one envelope, the first first.

import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues } from '../db/schema.js';
import { projectConfigDocuments } from '../db/schema-project-config.js';
import {
  issueDisplayIds,
  issuesMissingReleaseRecord,
  landingShapeOf,
  landingShortfall,
  requireLandingShape,
} from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { onlineCapableDeviceIds, releaseIneligibleRunners } from '../runners/index.js';
import { attempt, blocker, evaluate } from './blocker-kit.js';
import {
  type CollectReleaseBlockersOptions,
  type ReleaseBlocker,
  type ReleaseBlockerReport,
  type ReleaseDoor,
  type ReleaseWarning,
  runnerPreferenceUnmetSentence,
} from './blocker-sentences.js';
import {
  projectRunnerDeviceIds,
  type ReleaseChannel,
  refusedVerifyBindings,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
} from './channel.js';
import { claimConflictDetails, readClaimConflicts } from './claim-conflicts.js';
import { criteriaHold } from './criteria-hold.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
import { getActiveReleaseBatch } from './queries.js';
import { blockerRefusal, releaseBlockedRefusal } from './refuse.js';

export * from './blocker-sentences.js';

/** One move short of the gate — a run at its test step (ISS-54) — which `RELEASE_ROSTER_EMPTY`
 *  counts so its sentence names where the work stands. */
const NEAR_GATE = sql`${issues.status} = 'in_progress' AND EXISTS (
  SELECT 1 FROM issue_work_state w WHERE w.issue_id = ${issues.id} AND w.step = 'test')`;

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
        .where(and(eq(issues.projectId, projectId), NEAR_GATE)),
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
  // Sized like the roster; an empty named list falls through to read the gate.
  if (issueIds && issueIds.length > 0) {
    if (issueIds.length > RELEASE_ROSTER_LIMIT) out.push(oversize(issueIds.length));
    const named = await evaluate(
      'roster',
      async () =>
        await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.projectId, projectId), inArray(issues.id, issueIds))),
      out,
    );
    if (!named) return undefined;
    const ids = named.map((r) => r.id);
    return { ids, unclaimed: ids };
  }
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
    out.push(oversize(ids.length));
  }
  if (issueIds) return { ids: [], unclaimed: [] };
  return { ids, unclaimed: rows.filter((r) => r.claimed === null).map((r) => r.id) };
}

function oversize(waiting: number): ReleaseBlocker {
  return blocker('RELEASE_ROSTER_OVERSIZE', { waiting, limit: RELEASE_ROSTER_LIMIT }, 'roster');
}

async function claimBlockers(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[],
  out: ReleaseBlocker[],
): Promise<void> {
  const conflicts = await evaluate(
    'claim',
    async () => await readClaimConflicts(projectId, gateStatus, issueIds),
    out,
  );
  if (!conflicts || conflicts.length === 0) return;
  out.push(blocker('CLAIM_CONFLICT', claimConflictDetails(projectId, gateStatus, conflicts)));
}

/** `ISS-nn` for each, in the order given, so a refusal names the rows it is about (ISS-1346). A
 *  failed read costs the names and not the reason: the refusal still counts them, and says so. */
async function namedAs(ids: string[]): Promise<string[]> {
  try {
    const shown = await issueDisplayIds(ids);
    return ids.map((id) => shown.get(id) ?? id);
  } catch (err) {
    logger.warn({ err }, 'release-blockers: the refused issues could not be named');
    return [];
  }
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
    const displayIds = await namedAs(unrecorded);
    out.push(blocker('RELEASE_RECORD_MISSING', { issueIds: unrecorded, displayIds }));
  }
  if (door !== 'record') return;
  // Unmerged means what the close would refuse, on this project's shape: `landing-evidence.ts`.
  // Judged inside the read, so a source the reader cannot place is this check unevaluated, by name.
  const unmerged = await evaluate(
    'merged',
    async () => {
      const rows = await db
        .select({
          id: issues.id,
          mergedAt: issues.mergedAt,
          mergedCommitSha: issues.mergedCommitSha,
          mergedLanding: issues.mergedLanding,
          sourceType: sql<string | null>`${projectConfigDocuments.document} -> 'source' ->> 'type'`,
        })
        .from(issues)
        .leftJoin(projectConfigDocuments, eq(projectConfigDocuments.projectId, issues.projectId))
        .where(inArray(issues.id, issueIds));
      return rows
        .map((r) => ({
          id: r.id,
          shape: requireLandingShape(landingShapeOf(r.sourceType)),
          row: r,
        }))
        .filter((r) => landingShortfall(r.row, r.shape) !== null);
    },
    out,
  );
  if (!unmerged) return;
  if (unmerged.length > 0) {
    // One roster is one project, so one shape; it chooses which sentence the reader is owed.
    const shape = unmerged[0]?.shape;
    const ids = unmerged.map((r) => r.id);
    const displayIds = await namedAs(ids);
    out.push(blocker('RELEASE_WORK_UNMERGED', { issueIds: ids, shape, displayIds }));
  }
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
 * A production environment whose runtime probes all identify an artifact.
 *
 * Reported where the LIVE READ stands — last on a batch, after the roster on a
 * record — because that read is where this state fails. Any earlier and it
 * displaces a refusal the caller already gets for the same project.
 */
function unreadableProbeBlockers(channels: ReleaseChannel[], out: ReleaseBlocker[]): void {
  const bindings = refusedVerifyBindings(channels);
  if (bindings.length === 0) return;
  out.push(blocker('RELEASE_PROBES_UNREADABLE', { bindings }));
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
      blockers.push(blocker('RELEASE_TARGET_UNDECLARED', { reason: read.reason }));
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
  const channels = await gatedBlockers(projectId, door, options, blockers, warnings);
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
  options: CollectReleaseBlockersOptions,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
): Promise<ReleaseChannel[] | null> {
  const { issueIds } = options;
  // Both groups are READ here and REPORTED in the order the door refuses in.
  // A channel read that failed must not outrank a roster reason the batch door
  // reached first, or a reason an operator already knows is buried under an unread check.
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
    if (door === 'batch') {
      await poolBlockers(projectId, releaseRunnerLabelOf(channels), machinery, warnings);
      unreadableProbeBlockers(channels, machinery);
    }
  } else if (door === 'batch') {
    await poolBlockers(projectId, null, machinery, warnings);
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
    if (!issueIds && found) {
      await criteriaHold(
        projectId,
        found.unclaimed,
        out,
        warnings,
        options.serving,
        options.weighing,
      );
    }
  }
  return channels;
}

export * from './blocker-kit.js';

/**
 * A door's one blocker pass, refusing with every reason it found, the first first (ISS-1127). Every
 * id is then an issue at this project's gate, so its lower-case spelling is the row's own.
 */
export async function admitRoster(projectId: string, named: string[], door: ReleaseDoor) {
  const report = await collectReleaseBlockers(projectId, { issueIds: named, door });
  if (!report.projectExists) throw blockerRefusal('NO_RELEASE_GATE');
  const refusal = releaseBlockedRefusal(report);
  if (refusal) throw refusal;
  return { report, issueIds: named.map((id) => id.toLowerCase()) };
}
