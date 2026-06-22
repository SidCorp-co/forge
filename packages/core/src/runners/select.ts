import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type RunnerType, projects } from '../db/schema.js';
import { RUNNER_CAP_PER_RUNNER } from '../jobs/dispatch-gates.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import type { RequiredCapabilities, Runner } from './types.js';

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
 * a healthy device; `selectRunnerForJob`'s wrap-around still falls back to a
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

interface SelectInput {
  projectId: string;
  requiredCapabilities?: RequiredCapabilities;
  /**
   * PR-5 — When the orchestrator is resuming a session group, the job MUST
   * land on the same device that owns the prior Claude CLI session file
   * (sessions are local to the host that created them). Pass the prior
   * runner's deviceId here; selection still verifies online + liveness +
   * capabilities, so a stale pin gracefully falls through to the normal
   * selection logic (with the session-group resume aborted by the caller).
   */
  pinDeviceId?: string | null;
  /**
   * Auto-retry device rotation — every device already tried in this retry
   * chain. primary + pin + standby selection skip every id in the set so the
   * retry lands on a not-yet-tried runner. When the set covers every online
   * runner, selection re-runs with an EMPTY set so the chain wraps around
   * instead of starving (single-/few-device projects keep cycling rather than
   * parking on a manual hold).
   */
  excludeDeviceIds?: string[];
  /**
   * Retry-rotation flag (jobs/retry.ts). When true:
   *   - the primary-device preference (step 2) is SKIPPED — once a retry chain
   *     starts every online device is equal, so `defaultDeviceId` no longer
   *     wins; the caller pins the round-robin `target` via `pinDeviceId`;
   *   - the all-excluded wrap-around is DISABLED — the retry policy owns round
   *     resets (it clears the exclude set at a round boundary), so a fully
   *     excluded sweep returns null instead of silently re-hammering primary.
   * First dispatches leave this false → primary-pinned behaviour is unchanged.
   */
  skipPrimary?: boolean;
  /**
   * Per-project concurrency cap (`pipelineConfig.maxConcurrentIssues`, default
   * 1). When > 1 AND this is a first dispatch (`!skipPrimary`), runner choice
   * becomes LOAD-AWARE: primary-first, then spill to the least-loaded FREE
   * runner so independent issues fan across the pool instead of piling onto the
   * primary. At cap 1 (the default) selection is byte-for-byte the legacy
   * primary-pinned path. Retries (`skipPrimary`) always use the round-robin
   * regardless of cap. Defaults to 1 when omitted.
   */
  projectCap?: number;
}

type RunnerRow = {
  id: string;
  project_id: string;
  type: RunnerType;
  host: 'device' | 'remote';
  device_id: string | null;
  name: string;
  labels: unknown;
  capabilities: unknown;
  config: unknown;
  status: 'online' | 'offline' | 'draining' | 'disabled';
  last_seen_at: string | null;
  last_error: string | null;
  limit_reason: 'usage_limit' | 'rate_limit' | 'auth' | null;
  rate_limited_until: string | null;
  limit_detail: string | null;
};

function rowToRunner(r: RunnerRow): Runner {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
    host: r.host,
    deviceId: r.device_id,
    name: r.name,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    config: (r.config ?? {}) as Record<string, unknown>,
    status: r.status,
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
    lastError: r.last_error,
    limitReason: r.limit_reason,
    rateLimitedUntil: r.rate_limited_until ? new Date(r.rate_limited_until) : null,
    limitDetail: r.limit_detail,
  };
}

/**
 * ISS-232 — deterministic 3-step selector. Returns the first non-null:
 *
 *   1. **pin** (sticky session-group resume) — `pinDeviceId` runner if it
 *      is online + fresh + meets `requiredCapabilities`. A stale pin
 *      returns null so the caller can drop the `--resume` and dispatch a
 *      fresh session.
 *   2. **primary** — `projects.defaultDeviceId` runner if online + fresh +
 *      capable. Returns the primary EVEN WHEN IT IS AT IN-FLIGHT CAP:
 *      the picker's L4 EXISTS already gates on
 *      `fresh_capable_runners.in_flight < cap`, so the dispatcher won't
 *      pick a new job when the primary is full. We intentionally do NOT
 *      fall through to standby on "primary full" — that would let a load-
 *      balance pattern silently emerge against the spec
 *      ([docs/proposals/dispatch-load-balance-v2.md](primary-pinned)).
 *   3. **standby** — any other online + fresh runner on the project
 *      (device_id ≠ defaultDeviceId), ranked by `last_seen_at DESC, id
 *      ASC`. Deterministic — no `RANDOM()` tiebreaker — so a re-run with
 *      the same DB state always returns the same runner.
 *
 * Phase 2 (ISS-232) dropped the `fallbackChain` parameter and the
 * `capabilities.maxConcurrent` per-runner override; the runner/job-type
 * capability gate is enforced post-select via `runnerSupportsJobType`,
 * and runner cap is hardcoded to 1 across the codebase (claude-code +
 * antigravity were already 1, then 5; both collapse to 1 here).
 */
export async function selectRunnerForJob(input: SelectInput): Promise<Runner | null> {
  const { projectId, requiredCapabilities, pinDeviceId } = input;
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const excludeDeviceIds = input.excludeDeviceIds ?? [];
  const skipPrimary = input.skipPrimary ?? false;
  const projectCap = input.projectCap ?? 1;

  const picked = await pickRunner(projectId, required, livenessSeconds, {
    pinDeviceId: pinDeviceId ?? null,
    excludeDeviceIds,
    skipPrimary,
    projectCap,
  });
  if (picked) return picked;

  // First-dispatch wrap-around: when every device is excluded (e.g. all
  // tripped by the circuit breaker) re-run without the exclusion so a
  // single-/few-device project still gets a probe rather than wedging. This
  // is DISABLED for retry rotation (`skipPrimary`) — there the retry policy
  // owns round resets, and wrapping would silently re-hammer one device.
  if (!skipPrimary && excludeDeviceIds.length > 0) {
    return pickRunner(projectId, required, livenessSeconds, {
      pinDeviceId: pinDeviceId ?? null,
      excludeDeviceIds: [],
      skipPrimary,
      projectCap,
    });
  }
  return null;
}

async function pickRunner(
  projectId: string,
  required: string,
  livenessSeconds: number,
  opts: {
    pinDeviceId: string | null;
    excludeDeviceIds: string[];
    skipPrimary: boolean;
    projectCap: number;
  },
): Promise<Runner | null> {
  // Step 1 — pin. For a session-group resume this is the prior device; for a
  // retry rotation it is the round-robin `target`. The exclusion overrides the
  // pin so a done/tripped device is never re-picked (caller drops
  // `priorClaudeSessionId` when the pin is skipped — see dispatcher.ts).
  if (opts.pinDeviceId && !opts.excludeDeviceIds.includes(opts.pinDeviceId)) {
    const pinned = await findHealthyByDevice(
      projectId,
      opts.pinDeviceId,
      required,
      livenessSeconds,
    );
    if (pinned) return pinned;
    // Pin stale → fall through (retry rotation: to standby; first dispatch:
    // to primary then standby).
  }

  // Step 2 — primary (defaultDeviceId). Skipped for retry rotation, where
  // every online device is equal and the round-robin target drives selection.
  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const defaultDeviceId = project?.defaultDeviceId ?? null;

  // cap>1 first dispatch — LOAD-AWARE pool fan-out. Pick the least-loaded runner
  // that still has a FREE slot (in_flight < RUNNER_CAP_PER_RUNNER), preferring
  // the primary on ties so a usually-serial project keeps its warm primary and
  // only spills under load. Unlike the legacy primary step this NEVER returns a
  // full runner, so two independent issues land on two different hosts instead
  // of piling onto the primary. Retries (skipPrimary) keep the round-robin.
  if (!opts.skipPrimary && opts.projectCap > 1) {
    return pickLeastLoadedFreeRunner(projectId, required, livenessSeconds, {
      excludeDeviceIds: opts.excludeDeviceIds,
      preferDeviceId: defaultDeviceId,
    });
  }

  if (!opts.skipPrimary && defaultDeviceId && !opts.excludeDeviceIds.includes(defaultDeviceId)) {
    const primary = await findHealthyByDevice(
      projectId,
      defaultDeviceId,
      required,
      livenessSeconds,
    );
    if (primary) return primary;
    // Primary offline / stale / lacks capability → fallthrough to standby.
  }

  // Step 3 — standby. Excludes the primary device so a one-device project
  // doesn't double-pick its own primary; if defaultDeviceId is null the
  // exclusion clause collapses to a no-op. Also excludes every device already
  // tried in this retry chain.
  const standby = await findStandby(projectId, defaultDeviceId, required, livenessSeconds, {
    excludeDeviceIds: opts.excludeDeviceIds,
  });
  return standby;
}

/**
 * Lookup a single runner by `(projectId, deviceId)` constrained to
 * online + fresh + meets `requiredCapabilities`. Does NOT gate on
 * in-flight capacity — the primary is returned even when full so the
 * picker's L4 gate can keep the issue parked on the primary instead of
 * silently load-balancing it onto standby (see selector docstring).
 */
async function findHealthyByDevice(
  projectId: string,
  deviceId: string,
  required: string,
  livenessSeconds: number,
): Promise<Runner | null> {
  const rows = await db.execute<RunnerRow>(
    sql`
      SELECT id, project_id, type, host, device_id, name, labels,
             capabilities, config, status, last_seen_at, last_error,
             limit_reason, rate_limited_until, limit_detail
      FROM runners
      WHERE project_id = ${projectId}
        AND device_id = ${deviceId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (rate_limited_until IS NULL OR rate_limited_until <= now())
      ORDER BY last_seen_at DESC, id ASC
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}

/**
 * Deterministic standby pick — ranked by `last_seen_at DESC, id ASC` (no
 * `RANDOM()`). The picker's L4 in-flight gate is the SSOT for capacity;
 * the standby query does not duplicate it. `defaultDeviceId` is the
 * project's primary — pass null to skip the exclusion when the project
 * has no primary configured.
 */
async function findStandby(
  projectId: string,
  excludeDeviceId: string | null,
  required: string,
  livenessSeconds: number,
  extra: { excludeDeviceIds: string[] } = { excludeDeviceIds: [] },
): Promise<Runner | null> {
  // Exclusion uses `IS DISTINCT FROM` so NULL device_ids (remote/server
  // runners) participate correctly: `NULL <> 'd1'` is NULL, which fails
  // the WHERE filter, but `NULL IS DISTINCT FROM 'd1'` is true. The bound
  // values are parameterised so caller-controlled deviceIds can never reach
  // the literal SQL.
  const exclusionClause = excludeDeviceId
    ? sql`AND device_id IS DISTINCT FROM ${excludeDeviceId}`
    : sql``;
  // Retry-chain exclusion: skip every device already tried. One
  // `IS DISTINCT FROM` fragment per id (chains are bounded by the device
  // count) keeps remote runners (NULL device_id) eligible and every id
  // parameterised. The space separator is REQUIRED — each fragment starts
  // with `AND` but ends in a bound param (`… IS DISTINCT FROM $n`), so an
  // empty separator would render `$nAND` and break the SQL.
  const retryExclusionClause =
    extra.excludeDeviceIds.length > 0
      ? sql.join(
          extra.excludeDeviceIds.map((id) => sql`AND device_id IS DISTINCT FROM ${id}`),
          sql` `,
        )
      : sql``;
  const rows = await db.execute<RunnerRow>(
    sql`
      SELECT id, project_id, type, host, device_id, name, labels,
             capabilities, config, status, last_seen_at, last_error,
             limit_reason, rate_limited_until, limit_detail
      FROM runners
      WHERE project_id = ${projectId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (rate_limited_until IS NULL OR rate_limited_until <= now())
        ${exclusionClause}
        ${retryExclusionClause}
      ORDER BY last_seen_at DESC, id ASC
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}

/**
 * cap>1 LOAD-AWARE pick: the online + fresh + capable runner with a FREE slot
 * (in-flight < {@link RUNNER_CAP_PER_RUNNER}, orphan jobs under a terminal
 * pipeline_run excluded — mirrors the dispatch-gates `runner_load` CTE), ordered
 * primary-first (`preferDeviceId`) then least-loaded then freshest then id.
 * Deterministic (no RANDOM). Returns null when EVERY capable runner is full →
 * the job stays queued and a later tick (freed slot) re-picks it. This is the
 * spill mechanism that makes `maxConcurrentIssues>1` fan across the pool; the
 * dispatcher's per-runner CAS gate is the authoritative no-overload backstop.
 */
async function pickLeastLoadedFreeRunner(
  projectId: string,
  required: string,
  livenessSeconds: number,
  opts: { excludeDeviceIds: string[]; preferDeviceId: string | null },
): Promise<Runner | null> {
  const retryExclusionClause =
    opts.excludeDeviceIds.length > 0
      ? sql.join(
          opts.excludeDeviceIds.map((id) => sql`AND r.device_id IS DISTINCT FROM ${id}`),
          sql` `,
        )
      : sql``;
  const rows = await db.execute<RunnerRow>(
    sql`
      SELECT r.id, r.project_id, r.type, r.host, r.device_id, r.name, r.labels,
             r.capabilities, r.config, r.status, r.last_seen_at, r.last_error,
             r.limit_reason, r.rate_limited_until, r.limit_detail
      FROM runners r
      LEFT JOIN (
        -- per-runner in-flight, orphan-aware (parent pipeline_run non-terminal)
        SELECT j.runner_id, COUNT(*)::int AS in_flight
        FROM jobs j
        LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
        WHERE j.runner_id IS NOT NULL
          AND j.status IN ('dispatched','running')
          AND (pr.id IS NULL OR pr.status IN ('running','paused'))
        GROUP BY j.runner_id
      ) rl ON rl.runner_id = r.id
      WHERE r.project_id = ${projectId}
        AND r.status = 'online'
        AND r.capabilities @> ${required}::jsonb
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
        AND COALESCE(rl.in_flight, 0) < ${RUNNER_CAP_PER_RUNNER}
        ${retryExclusionClause}
      ORDER BY
        CASE WHEN r.device_id IS NOT DISTINCT FROM ${opts.preferDeviceId} THEN 0 ELSE 1 END,
        COALESCE(rl.in_flight, 0) ASC,
        r.last_seen_at DESC,
        r.id ASC
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}

/**
 * Distinct device ids that currently have an online + fresh runner capable of
 * `requiredCapabilities` on this project, deterministically ordered by
 * `device_id ASC`. The retry round-robin (jobs/retry.ts) uses this as the
 * candidate set: which devices a sweep cycles through, and when a round is
 * complete (every candidate already tried). Remote/server runners (NULL
 * device_id) are excluded — rotation is device-scoped.
 */
export async function onlineCapableDeviceIds(
  projectId: string,
  requiredCapabilities?: RequiredCapabilities,
): Promise<string[]> {
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
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
      ORDER BY device_id ASC
    `,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}
