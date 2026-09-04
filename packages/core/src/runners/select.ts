import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, type RunnerType, runners } from '../db/schema.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { deviceCapSql } from './device-cap.js';
import type { RequiredCapabilities, Runner } from './types.js';

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

// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts — every candidate predicate in this file must also sit in `fresh_capable_runners`; a clause here and not there makes the picker offer a job this selector then refuses, and the job spins `queued` forever with no gate reason
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
 * Remote/server runners (NULL `device_id`) drop out of a non-empty pool by
 * construction — a pool names devices, and `NULL IN (...)` is never true.
 *
 * `column` lets a caller that aliases `runners` pass `sql`r.device_id``.
 */
// cm:guard this belongs in the same WHERE as rate_limited_until, NOT in excludeDeviceIds — selectRunnerForJob's two wrap-arounds re-run with the exclude set EMPTIED, so a pool expressed as an exclusion evaporates exactly when every pool member is tripped
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
  /**
   * Per-state runner pool — the ONLY devices this job may land on
   * (`pipelineConfig.states[<stage>].deviceIds`, resolved by the dispatcher).
   * Null/empty = whole fleet. Every rule below (pin, primary, standby,
   * load-aware, wrap-around) operates strictly inside the pool.
   */
  allowDeviceIds?: string[] | null;
}

type RunnerRow = {
  id: string;
  project_id: string;
  type: RunnerType;
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
  quarantined_until: string | null;
  quarantine_reason: string | null;
};

function rowToRunner(r: RunnerRow): Runner {
  return {
    id: r.id,
    projectId: r.project_id,
    type: r.type,
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
    quarantinedUntil: r.quarantined_until ? new Date(r.quarantined_until) : null,
    quarantineReason: r.quarantine_reason,
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
 *      balance pattern silently emerge against the primary-pinned spec.
 *   3. **standby** — any other online + fresh runner on the project
 *      (device_id ≠ defaultDeviceId), ranked by `last_seen_at DESC, id
 *      ASC`. Deterministic — no `RANDOM()` tiebreaker — so a re-run with
 *      the same DB state always returns the same runner.
 *
 * Phase 2 (ISS-232) dropped the `fallbackChain` parameter and the
 * `capabilities.maxConcurrent` per-runner override; the runner/job-type
 * capability gate is enforced post-select via `runnerSupportsJobType`,
 * and runner cap is hardcoded to 1 across the codebase.
 */
export async function selectRunnerForJob(input: SelectInput): Promise<Runner | null> {
  const { projectId, requiredCapabilities, pinDeviceId } = input;
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const excludeDeviceIds = input.excludeDeviceIds ?? [];
  const skipPrimary = input.skipPrimary ?? false;
  const projectCap = input.projectCap ?? 1;
  const allowDeviceIds = input.allowDeviceIds ?? null;

  const picked = await pickRunner(projectId, required, livenessSeconds, {
    pinDeviceId: pinDeviceId ?? null,
    excludeDeviceIds,
    skipPrimary,
    projectCap,
    allowDeviceIds,
  });
  if (picked) return picked;

  // First-dispatch wrap-around: when every device is excluded (e.g. all
  // tripped by the circuit breaker) re-run without the exclusion so a
  // single-/few-device project still gets a probe rather than wedging.
  if (!skipPrimary && excludeDeviceIds.length > 0) {
    return pickRunner(projectId, required, livenessSeconds, {
      pinDeviceId: pinDeviceId ?? null,
      excludeDeviceIds: [],
      skipPrimary,
      projectCap,
      // cm:guard the wrap-around clears the EXCLUDE set only — `allowDeviceIds` must be forwarded intact, or an all-tripped pool silently probes a box the operator excluded from the stage
      allowDeviceIds,
    });
  }
  // Retry-specific last-resort wrap-around (ISS-596): when a retry rotation's
  // full exclude set has no healthy runner, re-run once with an empty exclude
  // set so that any online + non-limited device can be claimed. A genuinely
  // all-runners-limited project still returns null and self-heals on the next
  // tick once a limit window expires. The retry policy (nextRotation /
  // RETRY_MAX_ROUNDS) owns round boundaries and termination.
  if (skipPrimary && excludeDeviceIds.length > 0) {
    return pickRunner(projectId, required, livenessSeconds, {
      pinDeviceId: pinDeviceId ?? null,
      excludeDeviceIds: [],
      skipPrimary,
      projectCap,
      allowDeviceIds,
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
    allowDeviceIds: string[] | null;
  },
): Promise<Runner | null> {
  // cm:edge protocol -> packages/core/src/jobs/resume-policy.ts — falling through this pin STRANDS the caller's `--resume`: the CLI session file is on the pinned box and step 2/3 return a different one. `finalizeResumeForDevice` compares the returned device against the pin and drops the resume as `pin_stale`; a caller that skips it dispatches an unreachable session id and records the attempt as having continued the transcript.
  if (opts.pinDeviceId && !opts.excludeDeviceIds.includes(opts.pinDeviceId)) {
    const pinned = await findHealthyByDevice(
      projectId,
      opts.pinDeviceId,
      required,
      livenessSeconds,
      opts.allowDeviceIds,
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

  // cm:guard this arm must NEVER return a box already at its cap — unlike the legacy primary step, which returns the primary regardless. It is what makes two independent issues land on two hosts instead of piling onto one, and the tie-break toward the primary is what keeps a usually-serial project on its warm checkout until it actually has to spill.
  if (!opts.skipPrimary && opts.projectCap > 1) {
    return pickLeastLoadedFreeRunner(projectId, required, livenessSeconds, {
      excludeDeviceIds: opts.excludeDeviceIds,
      preferDeviceId: defaultDeviceId,
      allowDeviceIds: opts.allowDeviceIds,
    });
  }

  if (!opts.skipPrimary && defaultDeviceId && !opts.excludeDeviceIds.includes(defaultDeviceId)) {
    const primary = await findHealthyByDevice(
      projectId,
      defaultDeviceId,
      required,
      livenessSeconds,
      opts.allowDeviceIds,
    );
    if (primary) return primary;
    // Primary offline / stale / lacks capability → fallthrough to standby.
  }

  // Step 3 — standby. For a first dispatch, excludes the primary device so a
  // one-device project doesn't double-pick its own primary. For a retry
  // rotation (`skipPrimary`) every online device is equal — the primary carries
  // no special status, so its exclusion here would stranded a retry whose
  // non-primary target is temporarily rate-limited (ISS-596 wedge fix).
  // `defaultDeviceId` null collapses the exclusion clause to a no-op in both
  // cases. Also excludes every device already tried in this retry chain.
  const standby = await findStandby(
    projectId,
    opts.skipPrimary ? null : defaultDeviceId,
    required,
    livenessSeconds,
    { excludeDeviceIds: opts.excludeDeviceIds, allowDeviceIds: opts.allowDeviceIds },
  );
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
  allowDeviceIds: string[] | null = null,
): Promise<Runner | null> {
  const rows = await db.execute<RunnerRow>(
    sql`
      SELECT id, project_id, type, device_id, name, labels,
             capabilities, config, status, last_seen_at, last_error,
             limit_reason, rate_limited_until, limit_detail,
             quarantined_until, quarantine_reason
      FROM runners
      WHERE project_id = ${projectId}
        AND device_id = ${deviceId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (rate_limited_until IS NULL OR rate_limited_until <= now())
        ${NOT_QUARANTINED}
        ${NOT_AUTH_LIMITED}
        ${WORKSPACE_READY}
        ${NOT_DISABLED_DEVICE}
        ${poolClause(allowDeviceIds)}
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
  extra: { excludeDeviceIds: string[]; allowDeviceIds?: string[] | null } = {
    excludeDeviceIds: [],
  },
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
      SELECT id, project_id, type, device_id, name, labels,
             capabilities, config, status, last_seen_at, last_error,
             limit_reason, rate_limited_until, limit_detail,
             quarantined_until, quarantine_reason
      FROM runners
      WHERE project_id = ${projectId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (rate_limited_until IS NULL OR rate_limited_until <= now())
        ${NOT_QUARANTINED}
        ${NOT_AUTH_LIMITED}
        ${WORKSPACE_READY}
        ${NOT_DISABLED_DEVICE}
        ${poolClause(extra.allowDeviceIds)}
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
 * (in-flight < the device cap, orphan jobs under a terminal
 * pipeline_run excluded — mirrors the dispatch-gates `device_load` CTE), ordered
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
  opts: {
    excludeDeviceIds: string[];
    preferDeviceId: string | null;
    allowDeviceIds?: string[] | null;
  },
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
      SELECT r.id, r.project_id, r.type, r.device_id, r.name, r.labels,
             r.capabilities, r.config, r.status, r.last_seen_at, r.last_error,
             r.limit_reason, r.rate_limited_until, r.limit_detail,
             r.quarantined_until, r.quarantine_reason
      FROM runners r
      JOIN devices dv ON dv.id = r.device_id
      LEFT JOIN (
        -- per-DEVICE in-flight, orphan-aware (parent pipeline_run non-terminal)
        -- in-flight per DEVICE, orphan-aware; key aliased, see the guard above
        SELECT j.device_id AS load_device_id, COUNT(*)::int AS in_flight
        FROM jobs j
        LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
        WHERE j.device_id IS NOT NULL
          AND j.status IN ('dispatched','running')
          AND (pr.id IS NULL OR pr.status IN ('running','paused'))
        GROUP BY j.device_id
      ) rl ON rl.load_device_id = r.device_id
      WHERE r.project_id = ${projectId}
        AND r.status = 'online'
        AND r.capabilities @> ${required}::jsonb
        AND r.last_seen_at IS NOT NULL
        AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
        ${NOT_QUARANTINED}
        ${NOT_AUTH_LIMITED}
        ${WORKSPACE_READY}
        AND COALESCE(rl.in_flight, 0) < ${deviceCapSql('dv')}
        ${NOT_DISABLED_DEVICE}
        ${poolClause(opts.allowDeviceIds, sql`r.device_id`)}
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
 *
 * ISS-823 — health-gated by default (`rate_limited_until IS NULL OR <= now()`)
 * so this matches what `selectRunnerForJob` will actually accept; without the
 * gate the rotation could pin a `target` that selection then refuses, and
 * "every online box is limited" was invisible to the retry engine.
 * `includeLimited: true` returns the unfiltered set the retry engine also
 * needs, to tell all-exhausted apart from all-offline.
 */
export async function onlineCapableDeviceIds(
  projectId: string,
  requiredCapabilities?: RequiredCapabilities,
  opts?: { includeLimited?: boolean; allowDeviceIds?: string[] | null },
): Promise<string[]> {
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
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
        ${poolClause(opts?.allowDeviceIds)}
      ORDER BY device_id ASC
    `,
  );
  return rows.map((r) => r.device_id).filter((id): id is string => Boolean(id));
}
