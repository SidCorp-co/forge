// Which boxes could own a release right now, and what stops each one that cannot.
//
// A box owns a release through the run session its project's master opens over the roster, so a
// box may take one only where that session could be opened AND a master is there to open it: its
// runner is live, a master pane of this project is running on it, its plugin copy ships the role a
// master dispatches a release through, and its daemon is not draining. The last two only the box
// can say, and it says them on every heartbeat inside `capabilities` (ISS-1281).
//
// Every box serving the project gets exactly one answer, and the eligible set is derived from that
// list rather than filtered before it, so a refusal can name every box once.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerStatus, terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { logger } from '../logger.js';
import { classifyRunnerHold, type RunnerLivenessRow } from '../runners/ineligible.js';
import { ReleaseOwnerUnavailableError } from './errors.js';

/** The plugin role a master hands a release to, as `plugin/agents/<role>.md` names it. */
export const RELEASE_ROLE = 'release';

export type BoxAdmission =
  | { state: 'open' }
  | { state: 'draining'; cause: string; sinceMs: number; boundSecs: number; returnAtMs: number }
  | { state: 'unreported' };

export interface BoxCapabilities {
  releaseRole: boolean;
  admission: BoxAdmission;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * What a box's last heartbeat said it can do. A box that sent neither field — every runner older
 * than ISS-1281 — reads as shipping no release role, which is the truth about it.
 */
export function readBoxCapabilities(raw: unknown): BoxCapabilities {
  const caps = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const releaseRole = caps.releaseRole === true;
  const a = caps.admission as Record<string, unknown> | undefined;
  if (a?.state === 'open') return { releaseRole, admission: { state: 'open' } };
  if (
    a?.state === 'draining' &&
    typeof a.cause === 'string' &&
    finite(a.sinceMs) &&
    finite(a.boundSecs)
  ) {
    return {
      releaseRole,
      admission: {
        state: 'draining',
        cause: a.cause,
        sinceMs: a.sinceMs,
        boundSecs: a.boundSecs,
        returnAtMs: a.sinceMs + a.boundSecs * 1000,
      },
    };
  }
  return { releaseRole, admission: { state: 'unreported' } };
}

export type OwnerBoxReason = 'runner-held' | 'no-master' | 'no-release-role' | 'draining';

export interface OwnerBox {
  deviceId: string;
  deviceName: string;
  /** Carries the label the project's live binding prefers, where it prefers one. */
  labelled: boolean;
  /** `null` where this box may take the release. */
  reason: OwnerBoxReason | null;
  /** `runner-held`: the hold's own reading. `draining`: the drain's cause. */
  detail: string | null;
  /** `draining` only: the latest instant its admission comes back. */
  returnAtMs: number | null;
}

export interface OwnerBoxRow extends RunnerLivenessRow {
  deviceId: string;
  labels: string[];
  capabilities: unknown;
  hasMaster: boolean;
}

/** One box's answer. The order is the order an operator fixes them in. */
export function classifyOwnerBox(row: OwnerBoxRow, label: string | null, now: Date): OwnerBox {
  const base = {
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    labelled: label !== null && row.labels.includes(label),
    detail: null,
    returnAtMs: null,
  };
  const hold = classifyRunnerHold(row, now);
  if (hold) {
    return {
      ...base,
      reason: 'runner-held',
      detail: hold.detail ? `${hold.reason} (${hold.detail})` : hold.reason,
    };
  }
  if (!row.hasMaster) return { ...base, reason: 'no-master' };
  const caps = readBoxCapabilities(row.capabilities);
  if (!caps.releaseRole) return { ...base, reason: 'no-release-role' };
  if (caps.admission.state === 'draining') {
    return {
      ...base,
      reason: 'draining',
      detail: caps.admission.cause,
      returnAtMs: caps.admission.returnAtMs,
    };
  }
  return { ...base, reason: null };
}

export interface OwnerCandidates {
  label: string | null;
  /** False where no eligible box carries the preferred label. */
  preferenceMet: boolean;
  /** Every box serving the project, one answer each. */
  boxes: OwnerBox[];
  /** The boxes that may take the release now. */
  eligible: OwnerBox[];
}

/**
 * The label RANKS the boxes that could take a release; it never removes the only ones there are
 * (ISS-1128). Where an eligible box carries it, only those may take it.
 */
export function eligibleOwners(
  boxes: OwnerBox[],
  label: string | null,
): Pick<OwnerCandidates, 'eligible' | 'preferenceMet'> {
  const able = boxes.filter((b) => b.reason === null);
  if (label === null) return { eligible: able, preferenceMet: true };
  const preferred = able.filter((b) => b.labelled);
  return preferred.length > 0
    ? { eligible: preferred, preferenceMet: true }
    : { eligible: able, preferenceMet: false };
}

/** What a refusal, a readiness answer and the run screen say about one box. */
export interface OwnerBoxReading {
  deviceName: string;
  reason: OwnerBoxReason | null;
  detail: string | null;
  returnAt: string | null;
}

export function readingOf(box: OwnerBox): OwnerBoxReading {
  return {
    deviceName: box.deviceName,
    reason: box.reason,
    detail: box.detail,
    returnAt: box.returnAtMs === null ? null : new Date(box.returnAtMs).toISOString(),
  };
}

/** One clause per box, naming the act that would make it able to take the release. */
export function ownerBoxClause(box: OwnerBoxReading): string {
  const name = `\`${box.deviceName}\``;
  switch (box.reason) {
    case 'runner-held':
      return `${name}: its runner cannot take work (${box.detail}) — the Runners tab says why`;
    case 'no-master':
      return `${name}: no master pane of this project is running there, so nothing on it would take the release`;
    case 'no-release-role':
      return `${name}: its heartbeat reports no \`${RELEASE_ROLE}\` role, so its master has no role to hand a release to — update forge-runner and the forge plugin on it`;
    case 'draining':
      return `${name}: draining for ${box.detail}, so it admits no run until ${box.returnAt} at the latest`;
    case null:
      return `${name}: able to take it`;
  }
}

/** Why no box could own this release, for the person who pressed Release. */
export function noOwnerSentence(boxes: OwnerBoxReading[]): string {
  const clauses = boxes.length === 0 ? ['no box serves this project'] : boxes.map(ownerBoxClause);
  return (
    'No box serving this project could open the run session a release is owned by, so the release ' +
    `was not started and no issue was claimed. ${clauses.join('; ')}. A release is taken by this ` +
    'project’s master on a box whose runner is live, whose master pane is running, whose plugin ' +
    `ships the \`${RELEASE_ROLE}\` role and which is not draining.`
  );
}

interface OwnerBoxSqlRow extends Record<string, unknown> {
  device_id: string;
  device_name: string;
  status: RunnerStatus;
  last_seen_at: string | null;
  limit_reason: string | null;
  rate_limited_until: string | null;
  quarantined_until: string | null;
  provision_status: string | null;
  device_disabled_at: string | null;
  device_agent_version: string | null;
  labels: unknown;
  capabilities: unknown;
  has_master: boolean;
}

const asDate = (raw: string | null): Date | null => (raw === null ? null : new Date(raw));

// The same "live master" `liveMasterSessionId` asks for when a run session opens under it.
const terminalList = sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
);

/** Every runner row this project has, with what the owner rule reads off its box. */
async function readOwnerBoxRows(projectId: string): Promise<OwnerBoxRow[]> {
  const rows = await db.execute<OwnerBoxSqlRow>(sql`
    SELECT r.device_id, d.name AS device_name,
           r.status, r.last_seen_at, r.limit_reason, r.rate_limited_until,
           r.quarantined_until, r.provision_status,
           d.disabled_at AS device_disabled_at, d.agent_version AS device_agent_version,
           COALESCE(r.labels, '[]'::jsonb) AS labels,
           d.capabilities,
           EXISTS (
             SELECT 1 FROM agent_sessions m
              WHERE m.device_id = r.device_id
                AND m.project_id = r.project_id
                AND m.kind = ${MASTER_SESSION_KIND}
                AND m.status NOT IN (${terminalList})
           ) AS has_master
      FROM runners r
      JOIN devices d ON d.id = r.device_id
     WHERE r.project_id = ${projectId}
       AND r.device_id IS NOT NULL
     ORDER BY d.name ASC, r.device_id ASC
  `);
  return rows.map((r) => ({
    deviceId: r.device_id,
    deviceName: r.device_name,
    status: r.status,
    lastSeenAt: asDate(r.last_seen_at),
    limitReason: r.limit_reason,
    rateLimitedUntil: asDate(r.rate_limited_until),
    quarantinedUntil: asDate(r.quarantined_until),
    provisionStatus: r.provision_status,
    deviceDisabledAt: asDate(r.device_disabled_at),
    deviceAgentVersion: r.device_agent_version,
    labels: Array.isArray(r.labels)
      ? ((r.labels as unknown[]).filter((l) => typeof l === 'string') as string[])
      : [],
    capabilities: r.capabilities,
    hasMaster: r.has_master === true,
  }));
}

/** One answer per box: a box with several runner rows is able where any one of them is. */
function onePerBox(boxes: OwnerBox[]): OwnerBox[] {
  const byDevice = new Map<string, OwnerBox>();
  for (const box of boxes) {
    const seen = byDevice.get(box.deviceId);
    if (!seen || (seen.reason !== null && box.reason === null)) byDevice.set(box.deviceId, box);
  }
  return [...byDevice.values()];
}

export async function readOwnerCandidates(
  projectId: string,
  label: string | null,
  now: Date = new Date(),
): Promise<OwnerCandidates> {
  const rows = await readOwnerBoxRows(projectId);
  const boxes = onePerBox(rows.map((row) => classifyOwnerBox(row, label, now)));
  return { label, boxes, ...eligibleOwners(boxes, label) };
}

/**
 * The door's answer, before anything is written: a release no box could take is refused naming
 * every box, rather than cut and left at `releasing` with nothing owning it (ISS-1281, ISS-1323).
 */
export async function requireReleaseOwners(
  projectId: string,
  label: string | null,
): Promise<OwnerCandidates> {
  const owners = await readOwnerCandidates(projectId, label);
  if (owners.eligible.length === 0) {
    const boxes = owners.boxes.map(readingOf);
    throw new ReleaseOwnerUnavailableError(noOwnerSentence(boxes), boxes);
  }
  if (!owners.preferenceMet) {
    logger.warn(
      { projectId, releaseRunnerLabel: label },
      'release-batch: no box able to take this release carries the declared label, so any able box may take it',
    );
  }
  return owners;
}
