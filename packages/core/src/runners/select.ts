import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { RunnerType } from '../db/schema.js';
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
 * jsonb-containment of required capabilities. If `fallbackChain` is provided,
 * tries each type in order; otherwise considers all types.
 *
 * Ranking within a type: most-recently-seen wins. RANDOM() breaks ties so a
 * fleet of equal runners spreads load.
 */
export async function selectRunnerForJob(input: SelectInput): Promise<Runner | null> {
  const { projectId, requiredCapabilities, fallbackChain } = input;
  const required = JSON.stringify(requiredCapabilities ?? {});

  // Exclude runners whose last_seen_at is staler than the dispatch
  // liveness window — `status='online'` lags reality up to the
  // stale-detector cron interval.
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

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
