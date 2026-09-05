import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerType, runners } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { CLAIM_CAPABLE_DEVICE } from './device-cap.js';
import type { RequiredCapabilities } from './types.js';

/**
 * Device "turn off" gate — exclude any runner whose device the owner has
 * disabled (`devices.disabled_at` set). Correlates to the runner's `device_id`
 * in the enclosing query (works whether the runner row is aliased or not;
 * `devices` has no `device_id` column so the bare ref resolves outward).
 */
// cm:guard this correlates on a BARE `device_id` so it resolves outward whether or not the caller aliases `runners` — which means NO other column named `device_id` may be in scope where it is used. A join or subquery exposing a second one makes the reference ambiguous and Postgres fails the WHOLE query, which surfaces as "no runner available" for every job on the project rather than as an error anyone attributes to this line. Alias such keys (`AS load_device_id`), do not qualify this one.
const NOT_DISABLED_DEVICE = sql`AND NOT EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND d.disabled_at IS NOT NULL
)`;

// cm:edge lockstep -> packages/core/src/jobs/queued-gates.ts — every candidate predicate in this file must also sit in `fresh_capable_runners`; a clause here and not there makes the picker offer a job this selector then refuses, and the job spins `queued` forever with no gate reason
// cm:why placed alongside rate_limited_until (not a bare column ref) so it
// resolves correctly whether the enclosing query aliases `runners` as `r.` or not
const NOT_QUARANTINED = sql`AND (quarantined_until IS NULL OR quarantined_until <= now())`;

// cm:guard `auth` MUST be excluded by NAME, never left to `rate_limited_until` — that column is NULL for an auth limit BY DESIGN (no parseable reset), so the time-based filter passes it and an auth-dead box reads as perfectly healthy. lib/device-pool.ts has carried this exact clause for the chat path all along; the job path did not, and device dev1-ai013 took 421 jobs on an expired OAuth session in 5.5h (forge-beta 2026-08-14).
const NOT_AUTH_LIMITED = sql`AND limit_reason IS DISTINCT FROM 'auth'`;

// cm:guard NULL means "legacy row, never provisioned" and MUST stay eligible — 4 runners are NULL today and blocking them would starve their projects for a column they predate. Only an EXPLICIT non-ready value blocks.
// cm:guard a workspace that is not `ready` cannot run a job, and this gate is the only thing that says so — `provision_status` was write-only telemetry (web drew a stepper, no dispatch path read it), so runner ubuntu1/Anhome sat at `needs_manual_setup` while the picker fed it one job an hour for 8 hours, every one dying on `preflight_failed: work_tree` (measured 2026-08-14).
const WORKSPACE_READY = sql`AND (provision_status IS NULL OR provision_status = 'ready')`;

/**
 * Per-state runner pool (`pipelineConfig.states[x].deviceIds`) as a candidate
 * filter. `null`/empty pool → no fragment, so the fleet stays fully eligible.
 *
 * `column` lets a caller that aliases `runners` pass `sql`r.device_id``.
 */
// cm:guard this belongs in the same WHERE as rate_limited_until, NOT in an exclude set — the retry rotation re-runs with its exclusions cleared when a round wraps, so a pool expressed as an exclusion evaporates exactly when every pool member is tripped
// cm:guard build a parenthesised parameter list and use `IN (...)`. Drizzle expands an interpolated JS array as a ROW CONSTRUCTOR ($4,$5,$6,$7), so `= ANY(tuple::uuid[])` dies with `cannot cast type record to uuid[]` — the handler throws, pg-boss dead-letters after 2 retries, and the job row stays `queued` with `gateReason: null` forever. That killed EVERY dispatch on forge-dev for 11 days (2026-08-14 to 2026-08-25), because a pool is configured on every one of its states. Same idiom as lib/device-pool.ts.
function poolClause(deviceIds: string[] | null | undefined, column = sql`device_id`) {
  if (!deviceIds || deviceIds.length === 0) return sql``;
  return sql`AND ${column} IN (${sql.join(
    deviceIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/**
 * Decide the initial `capabilities` jsonb for a freshly-created runner row.
 *
 * Dev-mode (`NODE_ENV !== 'production'`) defaults `claude-code` runners with
 * `pm: true` so a stock `pnpm dev` setup can pick up PM jobs without an
 * extra opt-in step. Production never auto-grants PM — operators must enable
 * it explicitly via PATCH /api/runners/:id (ISS-18 requirement).
 *
 * Always returns the caller-provided capabilities verbatim when they are
 * supplied, so explicit `{}` from a callsite still clears the default.
 */
export function defaultRunnerCapabilities(
  type: RunnerType,
  provided?: Record<string, unknown>,
): Record<string, unknown> {
  if (provided !== undefined) return provided;
  if (type === 'claude-code' && process.env.NODE_ENV !== 'production') {
    return { pm: true };
  }
  return {};
}

/**
 * The `capabilities` jsonb of the device's `claude-code` runner, or `null`
 * when the device has none registered.
 *
 * `runners_device_type_uq` pins at most one `claude-code` runner per device, so
 * this row is the single place `capabilities.pm` — the PM opt-in written by
 * {@link defaultRunnerCapabilities} — can be read from.
 */
export async function readDeviceClaudeCodeCapabilities(
  deviceId: string,
): Promise<Record<string, unknown> | null> {
  const [runner] = await db
    .select({ capabilities: runners.capabilities })
    .from(runners)
    .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')))
    .limit(1);
  if (!runner) return null;
  return (runner.capabilities ?? {}) as Record<string, unknown>;
}

/**
 * Circuit breaker — number of consecutive recent FAILED terminal jobs on a
 * device (for a project) that trips it out of dispatch selection. Override via
 * `DEVICE_FAILURE_STREAK` env. Default 3.
 */
export const DEVICE_FAILURE_STREAK = (() => {
  const n = Number.parseInt(process.env.DEVICE_FAILURE_STREAK ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

/**
 * Recency window for the breaker. A device is only "tripped" while its most
 * recent failure is within this window, so a flapping device auto-recovers:
 * once dispatch rotates away and the failures age past the window, the device
 * becomes eligible again and gets a probe job. Override via
 * `DEVICE_TRIP_WINDOW_MS` env. Default 15 minutes.
 */
export const DEVICE_TRIP_WINDOW_MS = (() => {
  const n = Number.parseInt(process.env.DEVICE_TRIP_WINDOW_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
})();

/**
 * Return device ids dispatch selection should SKIP for this project because
 * their runner is failing repeatedly — the last `DEVICE_FAILURE_STREAK`
 * terminal jobs (`failed`|`done`; `cancelled` ignored as not
 * device-attributable) on that device are ALL `failed` and the most recent
 * failure is within `DEVICE_TRIP_WINDOW_MS`.
 *
 * The dispatcher merges these into `excludeDeviceIds`, so selection rotates to
 * a healthy device; the retry rotation's wrap-around still falls back to a
 * tripped device when EVERY device is tripped (better to try than to wedge).
 * A single succeeding job breaks the streak and the recency window ages stale
 * failures out, so the breaker is self-healing.
 */
export async function getTrippedDeviceIds(projectId: string): Promise<string[]> {
  const windowSeconds = Math.floor(DEVICE_TRIP_WINDOW_MS / 1000);
  const rows = await db.execute<{ device_id: string }>(
    sql`
      WITH recent AS (
        SELECT j.device_id, j.status, j.finished_at,
               row_number() OVER (
                 PARTITION BY j.device_id ORDER BY j.finished_at DESC
               ) AS rn
        FROM jobs j
        WHERE j.project_id = ${projectId}
          AND j.device_id IS NOT NULL
          AND j.finished_at IS NOT NULL
          AND j.status IN ('failed', 'done')
      )
      SELECT device_id
      FROM recent
      WHERE rn <= ${DEVICE_FAILURE_STREAK}
      GROUP BY device_id
      HAVING count(*) = ${DEVICE_FAILURE_STREAK}
         AND bool_and(status = 'failed')
         AND max(finished_at) > now() - (${windowSeconds} || ' seconds')::interval
    `,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}

/**
 * Distinct device ids that currently have an online + fresh runner capable of
 * `requiredCapabilities` on this project, deterministically ordered by
 * `device_id ASC`. The retry round-robin (jobs/retry.ts) uses this as the
 * candidate set: which devices a sweep cycles through, and when a round is
 * complete (every candidate already tried). Remote/server runners (NULL
 * device_id) are excluded — rotation is device-scoped.
 *
 * ISS-823 — health-gated by default (`rate_limited_until IS NULL OR <= now()`)
 * so this matches what the claim will actually accept; without the
 * gate the rotation could pin a `target` that selection then refuses, and
 * "every online box is limited" was invisible to the retry engine.
 * `includeLimited: true` returns the unfiltered set the retry engine also
 * needs, to tell all-exhausted apart from all-offline.
 */
export async function onlineCapableDeviceIds(
  projectId: string,
  requiredCapabilities?: RequiredCapabilities,
  opts?: {
    includeLimited?: boolean;
    includeBelowFloor?: boolean;
    allowDeviceIds?: string[] | null;
  },
): Promise<string[]> {
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  // cm:guard `includeBelowFloor` widens the set for REPORTING only and must never reach a routing caller — a below-floor box cannot claim, so a picker or rotation handed one is back in the deadlock this clause was added to close. Its single legitimate use is telling an operator "your fleet is too old" apart from "your fleet is offline", which are the same empty set otherwise.
  const floorClause = opts?.includeBelowFloor ? sql`` : CLAIM_CAPABLE_DEVICE;
  const limitClause = opts?.includeLimited
    ? sql``
    : sql`AND (rate_limited_until IS NULL OR rate_limited_until <= now()) ${NOT_QUARANTINED} ${NOT_AUTH_LIMITED}`;
  const rows = await db.execute<{ device_id: string }>(
    sql`
      SELECT DISTINCT device_id
      FROM runners
      WHERE project_id = ${projectId}
        AND device_id IS NOT NULL
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        ${limitClause}
        ${WORKSPACE_READY}
        ${NOT_DISABLED_DEVICE}
        ${floorClause}
        ${poolClause(opts?.allowDeviceIds)}
      ORDER BY device_id ASC
    `,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}
