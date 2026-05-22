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
  fallbackChain?: RunnerType[];
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
 * Pick a runner for a job. Filters by project + status='online' +
 * jsonb-containment of required capabilities.
 *
 * Ranking priority (most-preferred first):
 *   1. `pinDeviceId` if provided AND that runner is online + fresh + capable
 *      (PR-5 session-group resume — sessions are host-local, must hit the
 *      same machine that owns the prior session file).
 *   2. `projects.defaultDeviceId` if set AND that runner is online + fresh +
 *      capable (D1: project owner's primary device wins).
 *   3. Freshest-seen runner overall (fallback for multi-device / team setups
 *      or when the default is offline).
 *
 * `fallbackChain`, when present, gates by runner type at every step.
 */
export async function selectRunnerForJob(input: SelectInput): Promise<Runner | null> {
  const { projectId, requiredCapabilities, fallbackChain, pinDeviceId } = input;
  const required = JSON.stringify(requiredCapabilities ?? {});
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

  // 1. pinDeviceId — session-group resume
  if (pinDeviceId) {
    const pinned = await findByDevice(
      projectId,
      pinDeviceId,
      required,
      livenessSeconds,
      fallbackChain,
    );
    if (pinned) return pinned;
    // Fall through — pin stale → orchestrator will downgrade to fresh dispatch.
  }

  // 2. defaultDeviceId — project owner preference
  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project?.defaultDeviceId) {
    const def = await findByDevice(
      projectId,
      project.defaultDeviceId,
      required,
      livenessSeconds,
      fallbackChain,
    );
    if (def) return def;
  }

  // 3. Freshest fallback
  if (fallbackChain && fallbackChain.length > 0) {
    for (const type of fallbackChain) {
      const rows = await db.execute<RunnerRow>(
        sql`
          SELECT id, project_id, type, host, device_id, name, labels,
                 capabilities, config, status, last_seen_at, last_error
          FROM runners
          WHERE project_id = ${projectId}
            AND status = 'online'
            AND type = ${type}
            AND capabilities @> ${required}::jsonb
            AND last_seen_at IS NOT NULL
            AND last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
          ORDER BY last_seen_at DESC, RANDOM()
          LIMIT 1
        `,
      );
      if (rows.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length checked
        return rowToRunner(rows[0]!);
      }
    }
    return null;
  }

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
      ORDER BY last_seen_at DESC, RANDOM()
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}

/**
 * Lookup a single runner by (projectId, deviceId) with the same liveness/cap
 * gates. The runner-type filter is bound as a parameterised JSON array so
 * `fallbackChain` values are never interpolated into the SQL string —
 * eliminates any latent injection path when types come from type-erased
 * sources (JSON config, IPC, future API endpoints).
 *
 * `(SELECT array_agg(value::text) FROM jsonb_array_elements_text($1::jsonb))`
 * builds a `text[]` from the bound JSON array; `type = ANY(...)` then filters
 * against it. The bound value goes through libpq's parameter protocol so the
 * literal SQL never contains any caller-controlled string.
 */
async function findByDevice(
  projectId: string,
  deviceId: string,
  required: string,
  livenessSeconds: number,
  fallbackChain: RunnerType[] | undefined,
): Promise<Runner | null> {
  const hasChain = fallbackChain && fallbackChain.length > 0;
  const typeFilter = hasChain
    ? sql`AND type = ANY (
        SELECT value::text
        FROM jsonb_array_elements_text(${JSON.stringify(fallbackChain)}::jsonb)
      )`
    : sql``;

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
        ${typeFilter}
      ORDER BY last_seen_at DESC
      LIMIT 1
    `,
  );
  if (rows.length === 0) return null;
  // biome-ignore lint/style/noNonNullAssertion: length checked
  return rowToRunner(rows[0]!);
}
