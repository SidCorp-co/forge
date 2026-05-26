import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, type RunnerType } from '../db/schema.js';
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

  // Step 1 — pin (session-group resume)
  if (pinDeviceId) {
    const pinned = await findHealthyByDevice(projectId, pinDeviceId, required, livenessSeconds);
    if (pinned) return pinned;
    // Pin stale → caller will downgrade to fresh dispatch.
  }

  // Step 2 — primary (defaultDeviceId)
  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const defaultDeviceId = project?.defaultDeviceId ?? null;
  if (defaultDeviceId) {
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
  // exclusion clause collapses to a no-op.
  const standby = await findStandby(projectId, defaultDeviceId, required, livenessSeconds);
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
             capabilities, config, status, last_seen_at, last_error
      FROM runners
      WHERE project_id = ${projectId}
        AND device_id = ${deviceId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
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
): Promise<Runner | null> {
  // Exclusion uses `IS DISTINCT FROM` so NULL device_ids (remote/server
  // runners) participate correctly: `NULL <> 'd1'` is NULL, which fails
  // the WHERE filter, but `NULL IS DISTINCT FROM 'd1'` is true. The bound
  // value is parameterised so caller-controlled deviceIds can never reach
  // the literal SQL.
  const exclusionClause = excludeDeviceId
    ? sql`AND device_id IS DISTINCT FROM ${excludeDeviceId}`
    : sql``;
  const rows = await db.execute<RunnerRow>(
    sql`
      SELECT id, project_id, type, host, device_id, name, labels,
             capabilities, config, status, last_seen_at, last_error
      FROM runners
      WHERE project_id = ${projectId}
        AND status = 'online'
        AND capabilities @> ${required}::jsonb
        AND last_seen_at IS NOT NULL
        AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
        ${exclusionClause}
      ORDER BY last_seen_at DESC, id ASC
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}
