// Every reason a release will not start, enumerated once and read by every door (ISS-1127).
//
// Three properties the callers rely on: it never throws (a check that cannot be
// evaluated becomes an answer in the position that check held); it makes no outbound
// request, so what is checked here is the probe DECLARATION; and it reports in the order
// the doors refuse in, a door throwing the FIRST blocker under its existing name.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues } from '../db/schema.js';
import { issueDisplayIds } from '../issues/display-ids.js';
import { issuesMissingReleaseRecord } from '../issues/release-record-required.js';
import { logger } from '../logger.js';
import { releaseIneligibleRunners } from '../runners/ineligible.js';
import { onlineCapableDeviceIds } from '../runners/select.js';
import { attempt, blocker, evaluate } from './blocker-kit.js';
import {
  type CollectReleaseBlockersOptions,
  carriedUnreadWarningSentence,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlocker,
  type ReleaseBlockerReport,
  type ReleaseDoor,
  type ReleaseWarning,
  runnerPreferenceUnmetSentence,
} from './blocker-sentences.js';
import { type CarriedCheck, judgeCarried } from './carried.js';
import {
  projectRunnerDeviceIds,
  type ReleaseChannel,
  ReleaseRunnerAmbiguousError,
  refusedVerifyBindings,
  releaseRunnerLabelOf,
  resolveReleaseChannels,
  resolveReleaseDeviceIds,
} from './channel.js';
import { claimConflictDetails, readClaimConflicts } from './claim-conflicts.js';
import { rosterCloseShortfalls } from './close-shortfall.js';
import { criteriaHold } from './criteria-hold.js';
import { RELEASE_GATE_STATUS, resolveReleaseDeclaration } from './gate.js';
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
    // In the order the caller named them: a SELECT keeps no order, and every refusal lists these.
    // Postgres matches a uuid in either case and answers in lower case, so each id is read back
    // as the row's own spelling, once, or a roster in upper case is checked by no blocker.
    const held = new Map(named.map((r) => [r.id.toLowerCase(), r.id]));
    const ids = [...new Set(issueIds.map((id) => held.get(id.toLowerCase())))].filter(
      (id): id is string => id !== undefined,
    );
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

/** What the range carries beyond the roster, judged into the reasons and the warning it raises. */
function carriedBlockers(
  check: CarriedCheck,
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
): void {
  if (check.kind !== 'read') {
    if (check.kind === 'unbound') {
      warnings.push({
        code: 'RELEASE_CARRIED_UNREAD',
        message: carriedUnreadWarningSentence(check.why),
        details: { why: check.why },
      });
    }
    if (check.kind === 'unread') {
      out.push(blocker('RELEASE_CHECK_UNEVALUATED', { check: 'carried', detail: check.why }));
    }
    return;
  }
  const range = { live: check.live, start: check.start, cut: check.cut };
  if (check.refused.length > 0) {
    out.push(blocker('RELEASE_CARRIED_DECISION_REFUSED', { ...range, refused: check.refused }));
  }
  if (check.droppedRoster.length > 0) {
    const issueIds = check.droppedRoster.map((i) => i.issueId);
    const displayIds = check.droppedRoster.map((i) => i.displayId);
    out.push(blocker('RELEASE_CUT_DROPS_ROSTER', { ...range, issueIds, displayIds }));
  }
  if (check.undecided.length > 0) {
    const carried = check.undecided.map(({ issueId, displayId, title, status, landing }) => ({
      issueId,
      displayId,
      title,
      status,
      landing,
    }));
    out.push(blocker('RELEASE_CARRIES_UNDECIDED', { ...range, carried }));
  }
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

/** What the roster owes before it may be closed: a note, and whatever the finish's close would refuse. */
async function rosterBlockers(
  projectId: string,
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
  // The close's own refusals, read at both doors before anything is claimed (ISS-1337): a batch
  // that claimed such a row would release it and hand it back to the gate, said only afterwards.
  // `issueIds` is in the caller's roster order (`resolveRoster`), and so is every list below.
  const shortfalls = await evaluate(
    'close',
    async () => await rosterCloseShortfalls(projectId, issueIds),
    out,
  );
  if (!shortfalls) return;
  const ordered = issueIds.filter((id) => shortfalls.has(id));
  const landing = ordered.flatMap((id) =>
    (shortfalls.get(id) ?? [])
      .filter((s) => s.code === 'CLOSE_REQUIRES_SHIPPED')
      .map((s) => ({ id, shape: String(s.details.shape) })),
  );
  // An issue may declare its own lane, so one roster can hold both shapes, and each is owed the
  // sentence naming its own route: one blocker per shape, in roster order.
  for (const shape of [...new Set(landing.map((r) => r.shape))]) {
    const ids = landing.filter((r) => r.shape === shape).map((r) => r.id);
    const displayIds = await namedAs(ids);
    out.push(blocker('RELEASE_WORK_UNMERGED', { issueIds: ids, shape, displayIds }));
  }
  const rest = ordered.filter((id) =>
    (shortfalls.get(id) ?? []).some((s) => s.code !== 'CLOSE_REQUIRES_SHIPPED'),
  );
  if (rest.length === 0) return;
  const displayIds = await namedAs(rest);
  const refused = rest.map((id, i) => ({
    issueId: id,
    displayId: displayIds[i] ?? id,
    shortfalls: (shortfalls.get(id) ?? [])
      .filter((s) => s.code !== 'CLOSE_REQUIRES_SHIPPED')
      .map(({ code, reason, clears }) => ({ code, reason, clears })),
  }));
  out.push(blocker('RELEASE_ISSUES_UNCLOSABLE', { issueIds: rest, displayIds, refused }));
}

/** The label, and how many live bindings one reading would answer for. A channel declaring no
 *  probe is no reason here: its release is recorded unverified (ISS-1321). */
function channelBlockers(
  projectId: string,
  channels: ReleaseChannel[],
  door: ReleaseDoor,
  out: ReleaseBlocker[],
): string | null {
  let label: string | null = null;
  // The record door checks the channel COUNT first; the batch path checks it
  // last. Each door keeps its own order (ISS-1127).
  if (door === 'record' && channels.length > 1) {
    out.push(blocker('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: channels.length }));
  }
  try {
    // ISS-1275 — no label is no preference, which admits the pool it has.
    label = releaseRunnerLabelOf(projectId, channels);
  } catch (err) {
    const labels = err instanceof ReleaseRunnerAmbiguousError ? err.labels : [];
    out.push(blocker('RELEASE_RUNNER_AMBIGUOUS', { labels }));
  }
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
 * A probe url no request could be made to, or a `verify` Forge refused as a declaration.
 *
 * Reported where the LIVE READ stands — last on a batch, after the roster on a
 * record — because that read is where this state fails. Any earlier and it
 * displaces a refusal the caller already gets for the same project.
 */
function unreadableProbeBlockers(channels: ReleaseChannel[], out: ReleaseBlocker[]): void {
  const urls = channels.flatMap((c) => (c.verify ? invalidProbeUrls(c.verify) : []));
  const bindings = refusedVerifyBindings(channels);
  if (urls.length === 0 && bindings.length === 0) return;
  out.push(
    blocker('RELEASE_PROBES_UNREADABLE', bindings.length > 0 ? { urls, bindings } : { urls }),
  );
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
      blockers.push(blocker('RELEASE_TARGET_UNDECLARED', { releaseChain: read.releaseChain }));
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
  const gated = await gatedBlockers(projectId, door, options, blockers, warnings);
  return {
    projectId,
    projectExists: true,
    declaration: read ?? null,
    channels: gated.channels,
    blockers,
    warnings,
    ...(gated.carried ? { carried: gated.carried } : {}),
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
): Promise<{ channels: ReleaseChannel[] | null; carried: CarriedCheck | undefined }> {
  const { issueIds } = options;
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
  await rosterBlockers(projectId, found?.ids ?? [], roster);
  let carried: CarriedCheck | undefined;
  if (door === 'batch' && options.carried) {
    const rosterIds = issueIds && issueIds.length > 0 ? issueIds : (found?.ids ?? []);
    carried = judgeCarried(options.carried, rosterIds, options.decisions ?? []);
    carriedBlockers(carried, roster, warnings);
  }

  const machinery: ReleaseBlocker[] = [];
  if (ch.failure) machinery.push(ch.failure);
  if (channels) {
    const label = channelBlockers(projectId, channels, door, machinery);
    if (door === 'batch') {
      await poolBlockers(projectId, label, machinery, warnings);
      if (channels.length > 1) {
        machinery.push(blocker('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: channels.length }));
      }
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
  return { channels, carried };
}

export * from './blocker-errors.js';
export * from './blocker-kit.js';
