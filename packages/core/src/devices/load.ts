/**
 * What a master agent needs to decide how much work to take on.
 *
 * Three scopes, all raw counts: this device, this project, the project's
 * fleet. The master reads them and concludes; nothing here concludes for it.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export type DeviceLoad = {
  deviceId: string;
  name: string;
  jobsRunning: number;
  reposLocked: string[];
  agentVersion: string | null;
  lastSeenMinutes: number | null;
  /**
   * Every fault flag standing on this box's runners, verbatim: `auth` when the
   * Claude OAuth session died, `rate_limit` while a reset is pending, a
   * quarantine after repeated box-scoped failures.
   */
  // cm:guard report these RAW and never fold them into "usable: false". Before this design, `fresh_capable_runners` excluded an `auth` runner from dispatch by name, and that exclusion was ALSO the deadlock: `clearRunnerLimit` fires on a successful job, and the box could not win one while excluded. Nothing excludes it now, so this is the master's only way to know — and a master that reads `auth` can route around the box AND say why, which is the half the old gate could never do.
  runnerFaults: Array<{ runnerId: string; limitReason: string; until: string | null }>;
};

export type ProjectLoad = {
  projectId: string;
  slug: string;
  jobsRunning: number;
  poolDepth: number;
  byType: Record<string, number>;
  oldestRunningMinutes: number | null;
};

export type FleetEntry = {
  deviceId: string;
  name: string;
  online: boolean;
  jobsRunning: number;
  agentVersion: string | null;
  lastSeenMinutes: number | null;
  // cm:guard the fleet view carries faults for the same reason it keeps offline boxes: a master spreading three jobs over three boxes reads THIS list, and an `auth`-dead runner that looks healthy here gets one of them. Same shape as `DeviceLoad['runnerFaults']` — raw flags, never a usable/unusable verdict.
  runnerFaults: DeviceLoad['runnerFaults'];
};

const RUNNER_FAULTS = sql`COALESCE((
  SELECT json_agg(json_build_object(
           'runnerId', rf.id,
           'limitReason', rf.limit_reason,
           'until', rf.rate_limited_until))
  FROM runners rf
  WHERE rf.device_id = d.id AND rf.limit_reason IS NOT NULL
), '[]'::json) AS runner_faults`;

// cm:guard mirror `jobs/in-flight.ts#OCCUPYING_JOBS_FOR` EXACTLY — statuses AND the terminal-parent filter. A master sizing its next batch off a number that counts orphans reads a busy box where the claim will happily take more, and one that omits the filter reads a full box that is actually idle. Both directions end in a batch the box cannot honour.
const OCCUPYING = sql`j.status IN ('dispatched', 'running')
  AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))`;

export async function readDeviceLoad(deviceId: string): Promise<DeviceLoad | null> {
  const rows = (await db.execute(sql`
    SELECT d.id, d.name, d.agent_version,
           EXTRACT(EPOCH FROM (now() - d.last_seen_at)) / 60 AS last_seen_minutes,
           COALESCE(l.n, 0)::int AS jobs_running,
           COALESCE(l.repos, ARRAY[]::text[]) AS repos_locked,
           ${RUNNER_FAULTS}
    FROM devices d
    LEFT JOIN (
      SELECT j.device_id,
             COUNT(*)::int AS n,
             ARRAY_AGG(DISTINCT p.repo_path) FILTER (WHERE p.repo_path IS NOT NULL) AS repos
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      JOIN projects p ON p.id = j.project_id
      WHERE ${OCCUPYING}
      GROUP BY j.device_id
    ) l ON l.device_id = d.id
    WHERE d.id = ${deviceId}
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return null;
  return {
    deviceId: String(row.id),
    name: String(row.name),
    jobsRunning: Number(row.jobs_running ?? 0),
    reposLocked: (row.repos_locked as string[] | null) ?? [],
    agentVersion: (row.agent_version as string | null) ?? null,
    lastSeenMinutes: row.last_seen_minutes === null ? null : Number(row.last_seen_minutes),
    runnerFaults: (row.runner_faults as DeviceLoad['runnerFaults'] | null) ?? [],
  };
}

export async function readProjectLoad(projectId: string): Promise<ProjectLoad | null> {
  const rows = (await db.execute(sql`
    SELECT p.id, p.slug,
           COUNT(*) FILTER (WHERE ${OCCUPYING})::int AS jobs_running,
           COUNT(*) FILTER (
             WHERE j.status = 'queued'
               AND (pr.id IS NULL OR pr.status IN ('running', 'paused'))
           )::int AS pool_depth,
           MAX(EXTRACT(EPOCH FROM (now() - j.dispatched_at)) / 60)
             FILTER (WHERE ${OCCUPYING}) AS oldest_running_minutes
    FROM projects p
    LEFT JOIN jobs j ON j.project_id = p.id
    LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE p.id = ${projectId}
    GROUP BY p.id, p.slug
  `)) as unknown as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) return null;

  const typeRows = (await db.execute(sql`
    SELECT j.type, COUNT(*)::int AS n
    FROM jobs j
    LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    WHERE j.project_id = ${projectId} AND ${OCCUPYING}
    GROUP BY j.type
  `)) as unknown as Array<Record<string, unknown>>;

  const byType: Record<string, number> = {};
  for (const t of typeRows) byType[String(t.type)] = Number(t.n);

  return {
    projectId: String(row.id),
    slug: String(row.slug),
    jobsRunning: Number(row.jobs_running ?? 0),
    poolDepth: Number(row.pool_depth ?? 0),
    byType,
    oldestRunningMinutes:
      row.oldest_running_minutes === null ? null : Number(row.oldest_running_minutes),
  };
}

/** Every device bound to the project, whether or not it is online. */
// cm:guard an offline device stays in this list rather than being filtered out — the master's question is "where could this work go", and a box that dropped 60 minutes ago is a different answer from a box that never existed. Filtering makes a shrunken fleet indistinguishable from a small one.
export async function readFleetLoad(
  projectId: string,
  livenessSeconds: number,
): Promise<FleetEntry[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (d.id)
           d.id, d.name, d.agent_version,
           d.last_seen_at > now() - make_interval(secs => ${livenessSeconds}) AS online,
           EXTRACT(EPOCH FROM (now() - d.last_seen_at)) / 60 AS last_seen_minutes,
           COALESCE(l.n, 0)::int AS jobs_running,
           ${RUNNER_FAULTS}
    FROM runners r
    JOIN devices d ON d.id = r.device_id
    LEFT JOIN (
      SELECT j.device_id, COUNT(*)::int AS n
      FROM jobs j
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      WHERE ${OCCUPYING}
      GROUP BY j.device_id
    ) l ON l.device_id = d.id
    WHERE r.project_id = ${projectId}
    ORDER BY d.id, d.name
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    deviceId: String(row.id),
    name: String(row.name),
    online: row.online === true,
    jobsRunning: Number(row.jobs_running ?? 0),
    agentVersion: (row.agent_version as string | null) ?? null,
    lastSeenMinutes: row.last_seen_minutes === null ? null : Number(row.last_seen_minutes),
    runnerFaults: (row.runner_faults as DeviceLoad['runnerFaults'] | null) ?? [],
  }));
}
