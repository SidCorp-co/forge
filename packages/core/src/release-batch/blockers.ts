// Every reason a release will not start, enumerated once and read by every door (ISS-1127).
//
// Three properties the callers rely on: it never throws (a check that cannot be
// evaluated becomes an answer in the position that check held); it makes no outbound
// request, so what is checked here is the probe DECLARATION; and it reports in the order
// the doors refuse in, a door refusing with every blocker in one envelope, the first first.

import { RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues } from '../db/schema.js';
import { draftMissingReleaseNotes, issueCoresOf, waitingAtSql } from '../issues/index.js';
import { readGateProfile } from '../project-config/index.js';
import { onlineCapableDeviceIds, releaseIneligibleRunners } from '../runners/index.js';
import { attempt, blocker, collected, evaluate, settledValue } from './blocker-kit.js';
import {
  type CollectReleaseBlockersOptions,
  type ReleaseBlocker,
  type ReleaseBlockerReport,
  type ReleaseDoor,
  type ReleaseWarning,
  runnerPreferenceUnmetSentence,
} from './blocker-sentences.js';
import { changeRequestBlockers } from './change-request-roster.js';
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
import { endedRunBlocker } from './ended-claims.js';
import { RELEASE_GATE_STATUS, type ReleaseDeclaration, resolveReleaseDeclaration } from './gate.js';
import { promotionBlockers } from './promotion-standing.js';
import { getActiveReleaseBatch } from './queries.js';
import { blockerRefusal, releaseBlockedRefusal } from './refuse.js';
import { rosterBlockers } from './roster-blockers.js';
import { versionBlocker } from './version-blocker.js';

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

/** The issues this call is about: the caller's list, or the whole roster (`waitingAtSql`). */
async function resolveRoster(
  projectId: string,
  gateStatus: IssueStatus,
  issueIds: string[] | undefined,
  out: ReleaseBlocker[],
): Promise<RosterRead | undefined> {
  // Sized like the roster; an empty named list falls through to read the gate.
  if (issueIds && issueIds.length > 0) {
    if (issueIds.length > RELEASE_ROSTER_LIMIT) out.push(oversize(issueIds.length));
    // each issue's project from the request's one read of its issues (`issues/display-ids.ts`,
    // ISS-1070 r12): every project's draft weighed in a read asks it in one statement
    const named = await evaluate(
      'roster',
      async () => {
        const cores = await issueCoresOf([...new Set(issueIds.map((id) => id.toLowerCase()))]);
        return [...cores.values()].filter((c) => c.projectId === projectId);
      },
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
        .where(and(eq(issues.projectId, projectId), waitingAtSql(sql`${issues}`, gateStatus))),
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
      // the whole pool and the fleet are asked beside the labelled boxes, not after them (ISS-1070 r17)
      const [labelledPool, anyPool, fleet] = await Promise.allSettled([
        (async () => {
          const labelled = label ? await resolveReleaseDeviceIds(projectId, label) : [];
          return labelled.length === 0
            ? []
            : await onlineCapableDeviceIds(projectId, {}, { allowDeviceIds: labelled });
        })(),
        onlineCapableDeviceIds(projectId, {}),
        projectRunnerDeviceIds(projectId),
      ]);
      const preferred = settledValue(labelledPool);
      const eligible = preferred.length > 0 ? preferred : settledValue(anyPool);
      return { preferenceMet: preferred.length > 0, eligible, fleet: settledValue(fleet) };
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
 * Reported where the LIVE READ stands — last on a batch — because that read is
 * where this state fails. A record reads nothing live (ISS-851), so it never
 * owes this.
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
    // With no production environment a record is the landing's own (`recorded-landing.ts`): there is
    // no gate to refuse, and its roster owes what every record's does.
    // Production deployed outside Forge by a door it names (ISS-851): the agent's record is the
    // release, owing what every record's roster does; any other door cuts nothing and is refused by name.
    if (read.kind === 'external' && door !== 'record') {
      blockers.push(blocker('RELEASE_DEPLOYED_OUTSIDE'));
      return {
        projectId,
        projectExists: true,
        declaration: read,
        channels: [],
        blockers,
        warnings,
      };
    }
    if ((read.kind === 'no-release' || read.kind === 'external') && door === 'record') {
      const { issueIds } = options;
      const found = await resolveRoster(projectId, RELEASE_GATE_STATUS, issueIds, blockers);
      if (issueIds && issueIds.length > 0) {
        await claimBlockers(projectId, RELEASE_GATE_STATUS, issueIds, blockers);
      }
      await rosterBlockers(projectId, door, found?.ids ?? [], blockers);
      return {
        projectId,
        projectExists: true,
        declaration: read,
        channels: [],
        blockers,
        warnings,
      };
    }
    if (read.kind === 'change-requests' || read.kind === 'promotion') {
      if (door === 'record' && read.kind === 'change-requests')
        blockers.push(blocker('RELEASE_THROUGH_CHANGE_REQUESTS'));
      else if (door !== 'record')
        await changeRequestReleaseBlockers(projectId, options, blockers, warnings, read);
      return {
        projectId,
        projectExists: true,
        declaration: read,
        channels: [],
        blockers,
        warnings,
      };
    }
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
  const batch = door === 'batch';
  // Every check is READ at once, each into a list of its own, and REPORTED in the order the door
  // refuses in: a read of a draft waits on the deepest check, not on all of them in turn (ISS-1070
  // r17). A channel read that failed must not outrank a roster reason the batch door reached first,
  // or a reason an operator already knows is buried under an unread check.
  const chRead = attempt('channels', async () => await resolveReleaseChannels(projectId));
  const foundRead = collected((o) => resolveRoster(projectId, RELEASE_GATE_STATUS, issueIds, o));
  const [ch, found, claims, owed, ended, pool, rest] = await Promise.all([
    chRead,
    foundRead,
    issueIds && issueIds.length > 0
      ? collected((o) => claimBlockers(projectId, RELEASE_GATE_STATUS, issueIds, o))
      : null,
    foundRead.then((f) => collected((o) => rosterBlockers(projectId, door, f.value?.ids ?? [], o))),
    batch ? collected((o) => endedRunBlocker(projectId, o)) : null,
    batch ? chRead.then((c) => machineryBlockers(projectId, c.value ?? null)) : null,
    batch ? foundRead.then((f) => batchBlockers(projectId, options, f.value)) : null,
  ]);
  const channels = ch.value ?? null;
  const roster = [...found.out, ...(claims?.out ?? []), ...owed.out, ...(ended?.out ?? [])];
  const machinery = [...(ch.failure ? [ch.failure] : []), ...(pool?.out ?? [])];
  out.push(...(batch ? [...roster, ...machinery] : [...machinery, ...roster]));
  warnings.push(...(pool?.value ?? []));
  if (rest) {
    out.push(...rest.out);
    warnings.push(...rest.value);
  }
  return channels;
}

/** The runner pool a batch would take, and the probes it could not read; with the warnings they raise. */
function machineryBlockers(projectId: string, channels: ReleaseChannel[] | null) {
  return collected(async (o) => {
    const warnings: ReleaseWarning[] = [];
    if (channels) {
      await poolBlockers(projectId, releaseRunnerLabelOf(channels), o, warnings);
      unreadableProbeBlockers(channels, o);
    } else {
      await poolBlockers(projectId, null, o, warnings);
    }
    return warnings;
  });
}

/**
 * What a batch owes after its roster and machinery, read at once and reported in order: a release
 * already running, the version, and where the whole gate is weighed, its criteria. Either door
 * reading a batch asks these.
 */
function batchBlockers(
  projectId: string,
  options: CollectReleaseBlockersOptions,
  found: RosterRead | undefined,
) {
  const { issueIds } = options;
  return collected(async (o) => {
    const warnings: ReleaseWarning[] = [];
    const [active, version, held] = await Promise.all([
      collected((a) =>
        evaluate('in-flight', async () => await getActiveReleaseBatch(projectId), a),
      ),
      collected((v) =>
        versionBlocker(projectId, issueIds && issueIds.length > 0 ? issueIds : found?.ids, v),
      ),
      !issueIds && found
        ? collected((c) =>
            criteriaHold(
              projectId,
              found.unclaimed,
              c,
              warnings,
              options.serving,
              options.weighing,
            ),
          )
        : null,
    ]);
    o.push(...active.out);
    if (active.value) {
      o.push(
        blocker('BATCH_IN_FLIGHT', { runId: active.value.runId, version: active.value.version }),
      );
    }
    o.push(...version.out, ...(held?.out ?? []));
    return warnings;
  });
}

/**
 * What a release that merges change requests owes (REQ-63): the roster's own reasons and every
 * request it ships, then a release already running and the version. It deploys nothing, so no
 * channel, runner pool or probe is asked of it.
 */
async function changeRequestReleaseBlockers(
  projectId: string,
  options: CollectReleaseBlockersOptions,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
  read: Extract<ReleaseDeclaration, { kind: 'change-requests' | 'promotion' }>,
): Promise<void> {
  const { issueIds } = options;
  const named = issueIds !== undefined && issueIds.length > 0;
  // every check is read at once and reported in the order the door refuses in (ISS-1070 r17)
  const foundRead = collected((o) => resolveRoster(projectId, RELEASE_GATE_STATUS, issueIds, o));
  const rosterOf = (found: RosterRead | undefined) =>
    named ? (found?.ids ?? []) : (found?.unclaimed ?? []);
  const [found, claims, owed, ended, requests, rest] = await Promise.all([
    foundRead,
    named ? collected((o) => claimBlockers(projectId, RELEASE_GATE_STATUS, issueIds, o)) : null,
    foundRead.then((f) =>
      collected((o) => rosterBlockers(projectId, 'batch', rosterOf(f.value), o)),
    ),
    collected((o) => endedRunBlocker(projectId, o)),
    foundRead.then((f) =>
      collected((o) =>
        read.kind === 'change-requests'
          ? changeRequestBlockers(projectId, rosterOf(f.value), o)
          : promotionBlockers(projectId, read, rosterOf(f.value), o),
      ),
    ),
    foundRead.then((f) => batchBlockers(projectId, options, f.value)),
  ]);
  out.push(
    ...found.out,
    ...(claims?.out ?? []),
    ...owed.out,
    ...ended.out,
    ...requests.out,
    ...rest.out,
  );
  warnings.push(...rest.value);
}

export * from './blocker-kit.js';

/**
 * A door's one blocker pass, refusing with every reason it found, the first first (ISS-1127). Every
 * id is then an issue at this project's gate, so its lower-case spelling is the row's own.
 */
export async function admitRoster(projectId: string, named: string[], door: ReleaseDoor) {
  // outside strict a missing note is drafted here, at the act, never refused (REQ-79 r6 BC-16)
  if ((await readGateProfile(projectId)) !== 'strict')
    await draftMissingReleaseNotes(projectId, named);
  const report = await collectReleaseBlockers(projectId, { issueIds: named, door });
  if (!report.projectExists) throw blockerRefusal('NO_RELEASE_GATE');
  const refusal = releaseBlockedRefusal(report);
  if (refusal) throw refusal;
  return { report, issueIds: named.map((id) => id.toLowerCase()) };
}
