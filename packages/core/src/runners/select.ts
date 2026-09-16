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
const NOT_DISABLED_DEVICE = sql`AND NOT EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND d.disabled_at IS NOT NULL
)`;

const NOT_QUARANTINED = sql`AND (quarantined_until IS NULL OR quarantined_until <= now())`;

const NOT_AUTH_LIMITED = sql`AND limit_reason IS DISTINCT FROM 'auth'`;

const WORKSPACE_READY = sql`AND (provision_status IS NULL OR provision_status = 'ready')`;

/**
 * Per-state runner pool (`pipelineConfig.states[x].deviceIds`) as a candidate
 * filter. `null`/empty pool → no fragment, so the fleet stays fully eligible.
 *
 * `column` lets a caller that aliases `runners` pass `sql`r.device_id``.
 */
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
 * `capabilities.pm` is the PM opt-in written by {@link defaultRunnerCapabilities}.
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
