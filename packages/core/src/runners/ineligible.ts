/**
 * Why each registered runner of a project cannot be handed work right now.
 *
 * `onlineCapableDeviceIds` answers WHETHER any box is eligible and nothing
 * answered why not, so `NO_RUNNER_ONLINE` named no act for a box that is up,
 * heartbeating and `draining` (ISS-1127). Database reads alone, because
 * `collectReleaseBlockers` promises to reach no network.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { RunnerStatus } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { AGENT_NAMING_MIN_RUNNER, atLeastVersion } from './device-cap.js';

export type RunnerHoldReason =
  | 'device-disabled'
  | 'retired'
  | 'never-connected'
  | 'disconnected'
  | 'stale'
  | 'auth'
  | 'rate-limited'
  | 'quarantined'
  | 'provisioning'
  | 'below-floor';

/** The columns the dispatch filter reads, and only those. */
export interface RunnerLivenessRow {
  name: string;
  status: RunnerStatus;
  lastSeenAt: Date | null;
  limitReason: string | null;
  rateLimitedUntil: Date | null;
  quarantinedUntil: Date | null;
  provisionStatus: string | null;
  deviceDisabledAt: Date | null;
  deviceAgentVersion: string | null;
}

export interface RunnerHold {
  name: string;
  reason: RunnerHoldReason;
  /** The reading itself, where naming it tells the operator which box to open. */
  detail?: string;
  /** Seconds since its last heartbeat; null where it has never reported. */
  lastSeenSeconds: number | null;
  /** Inside the dispatch window. On EVERY hold: a box can be retired and silent
   *  at once, and a clause calling that one reporting is the same omission. */
  reporting: boolean;
}

/**
 * The order a hold is selected in, which is a presentation rule and not the
 * database's.
 *
 * `onlineCapableDeviceIds` ANDs its conditions, so a row failing four of them
 * fails them equally and the SQL ranks nothing. This order is chosen as the one
 * the operator acts in — a turned-off device before a retired runner, a retired
 * runner before a limit that expires on its own — and the test pins it so the
 * choice stays a decision rather than a side effect of statement order.
 */
export const RUNNER_HOLD_PRECEDENCE: readonly RunnerHoldReason[] = [
  'device-disabled',
  'retired',
  'never-connected',
  'disconnected',
  'stale',
  'auth',
  'rate-limited',
  'quarantined',
  'provisioning',
  'below-floor',
];

function secondsSince(at: Date, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
}

function reasonFor(
  row: RunnerLivenessRow,
  now: Date,
  fresh: boolean,
): { reason: RunnerHoldReason; detail?: string } | null {
  if (row.deviceDisabledAt !== null) return { reason: 'device-disabled' };
  if (row.status === 'draining' || row.status === 'disabled') {
    return { reason: 'retired', detail: row.status };
  }
  if (row.status === 'offline') {
    return row.lastSeenAt === null ? { reason: 'never-connected' } : { reason: 'disconnected' };
  }
  if (row.lastSeenAt === null) return { reason: 'never-connected' };
  if (!fresh) return { reason: 'stale' };
  if (row.limitReason === 'auth') return { reason: 'auth' };
  if (row.rateLimitedUntil !== null && row.rateLimitedUntil > now) {
    return { reason: 'rate-limited', detail: row.rateLimitedUntil.toISOString() };
  }
  if (row.quarantinedUntil !== null && row.quarantinedUntil > now) {
    return { reason: 'quarantined', detail: row.quarantinedUntil.toISOString() };
  }
  if (row.provisionStatus !== null && row.provisionStatus !== 'ready') {
    return { reason: 'provisioning', detail: row.provisionStatus };
  }
  if (!atLeastVersion(row.deviceAgentVersion, AGENT_NAMING_MIN_RUNNER)) {
    return { reason: 'below-floor', detail: row.deviceAgentVersion ?? 'unreported' };
  }
  return null;
}

/** The reading this box is held by, or `null` where it would be dispatched to. */
export function classifyRunnerHold(
  row: RunnerLivenessRow,
  now: Date = new Date(),
  livenessMs: number = dispatchLivenessMs(),
): RunnerHold | null {
  const lastSeenSeconds = row.lastSeenAt === null ? null : secondsSince(row.lastSeenAt, now);
  const fresh = row.lastSeenAt !== null && now.getTime() - row.lastSeenAt.getTime() <= livenessMs;
  const found = reasonFor(row, now, fresh);
  if (!found) return null;
  return {
    name: row.name,
    reason: found.reason,
    ...(found.detail === undefined ? {} : { detail: found.detail }),
    lastSeenSeconds,
    reporting: fresh,
  };
}

interface RunnerLivenessSqlRow extends Record<string, unknown> {
  name: string;
  status: RunnerStatus;
  last_seen_at: string | null;
  limit_reason: string | null;
  rate_limited_until: string | null;
  quarantined_until: string | null;
  provision_status: string | null;
  device_disabled_at: string | null;
  device_agent_version: string | null;
}

const asDate = (raw: string | null): Date | null => (raw === null ? null : new Date(raw));

export async function readRunnerLiveness(projectId: string): Promise<RunnerLivenessRow[]> {
  const rows = await db.execute<RunnerLivenessSqlRow>(sql`
    SELECT r.name, r.status, r.last_seen_at, r.limit_reason, r.rate_limited_until,
           r.quarantined_until, r.provision_status,
           d.disabled_at AS device_disabled_at, d.agent_version AS device_agent_version
      FROM runners r
      JOIN devices d ON d.id = r.device_id
     WHERE r.project_id = ${projectId}
     ORDER BY r.name ASC
  `);
  return rows.map((r) => ({
    name: r.name,
    status: r.status,
    lastSeenAt: asDate(r.last_seen_at),
    limitReason: r.limit_reason,
    rateLimitedUntil: asDate(r.rate_limited_until),
    quarantinedUntil: asDate(r.quarantined_until),
    provisionStatus: r.provision_status,
    deviceDisabledAt: asDate(r.device_disabled_at),
    deviceAgentVersion: r.device_agent_version,
  }));
}

/**
 * Every registered runner that could not take work, with its reading. Asked only
 * where no device came back eligible, and a device is eligible when ANY of its
 * rows passes — so then every row is held and every reading is a reason.
 */
export async function releaseIneligibleRunners(projectId: string): Promise<RunnerHold[]> {
  const rows = await readRunnerLiveness(projectId);
  const now = new Date();
  const held: RunnerHold[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const hold = classifyRunnerHold(row, now);
    if (!hold) continue;
    const key = `${hold.name}|${hold.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    held.push(hold);
  }
  return held;
}
