import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  type RunnerStatus,
  type RunnerType,
  runnerEvents,
  runners,
} from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';

export type RunnerRow = typeof runners.$inferSelect;

/** One runner by id; null when there is none. */
export async function runnerRow(id: string): Promise<RunnerRow | null> {
  const [row] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
  return row ?? null;
}

/** Every project a device runs a runner for, whatever the runner's type. */
export async function deviceProjectIds(deviceId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: runners.projectId })
    .from(runners)
    .where(eq(runners.deviceId, deviceId));
  return rows.map((r) => r.projectId);
}

/** The device and project a runner belongs to; null when there is no such runner. */
export async function runnerPlacement(
  id: string,
): Promise<{ deviceId: string; projectId: string } | null> {
  const [row] = await db
    .select({ deviceId: runners.deviceId, projectId: runners.projectId })
    .from(runners)
    .where(eq(runners.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Every device that runs a runner for a project, each listed once: one device may serve a project
 * through more than one runner row, and a device listed twice would be woken twice for one issue.
 */
export async function projectDeviceIds(projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ deviceId: runners.deviceId })
    .from(runners)
    .where(eq(runners.projectId, projectId));
  return rows.map((r) => r.deviceId);
}

/** A project's runners, narrowed by type and status when given. */
export async function listProjectRunners(
  projectId: string,
  filter: { type?: RunnerType | undefined; status?: RunnerStatus | undefined },
): Promise<RunnerRow[]> {
  const filters = [eq(runners.projectId, projectId)];
  if (filter.type) filters.push(eq(runners.type, filter.type));
  if (filter.status) filters.push(eq(runners.status, filter.status));
  return db
    .select()
    .from(runners)
    .where(and(...filters));
}

/** Each of a project's runners with the job it is working, if any, and how many are busy. */
export async function activeRunnersOf(projectId: string) {
  const rows = await db.execute<{
    runner_id: string;
    runner_name: string;
    status: string;
    last_seen_at: string | null;
    job_id: string | null;
    job_type: string | null;
    dispatched_at: string | null;
    issue_id: string | null;
    iss_seq: number | null;
    issue_prefix: string | null;
    issue_title: string | null;
  }>(sql`
    SELECT
      r.id          AS runner_id,
      r.name        AS runner_name,
      r.status      AS status,
      r.last_seen_at AS last_seen_at,
      j.id          AS job_id,
      j.type        AS job_type,
      j.dispatched_at AS dispatched_at,
      i.id          AS issue_id,
      i.iss_seq     AS iss_seq,
      rp.issue_prefix AS issue_prefix,
      i.title       AS issue_title
    FROM runners r
    -- Orphan exclusion (ISS-258) lives in the JOIN, not a WHERE clause, so a
    -- runner whose only active job is parented by a terminal pipeline_run
    -- still appears — as IDLE — instead of dropping out of the result.
    LEFT JOIN jobs j
      ON j.runner_id = r.id
     AND j.status = 'dispatched'
    LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    LEFT JOIN issues i ON i.id = j.issue_id
    LEFT JOIN projects rp ON rp.id = i.project_id
    WHERE r.project_id = ${projectId}
      AND (j.id IS NULL OR pr.id IS NULL OR pr.status IN ('running','paused'))
    ORDER BY r.name ASC, j.dispatched_at ASC NULLS LAST
  `);

  const byRunner = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byRunner.get(row.runner_id);
    if (!existing || (!existing.job_id && row.job_id)) byRunner.set(row.runner_id, row);
  }

  const runnersOut = [...byRunner.values()].map((row) => ({
    runnerId: row.runner_id,
    name: row.runner_name,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    current: row.job_id
      ? {
          jobId: row.job_id,
          stage: row.job_type,
          startedAt: row.dispatched_at,
          issueId: row.issue_id,
          issueRef: row.iss_seq != null ? formatIssueRef(row.issue_prefix, row.iss_seq) : null,
          issueTitle: row.issue_title,
        }
      : null,
  }));

  const busy = runnersOut.filter((r) => r.current).length;
  return { runners: runnersOut, busy, total: runnersOut.length };
}

/**
 * A runner's status timeline and the recent sessions on its device, each with the last transcript
 * line naming a tool or result error (extracted in SQL so the `messages` jsonb never leaves).
 */
export async function runnerActivity(row: RunnerRow, limit: number) {
  const events = await db
    .select({
      id: runnerEvents.id,
      oldStatus: runnerEvents.oldStatus,
      newStatus: runnerEvents.newStatus,
      reason: runnerEvents.reason,
      ts: runnerEvents.ts,
    })
    .from(runnerEvents)
    .where(eq(runnerEvents.runnerId, row.id))
    .orderBy(desc(runnerEvents.ts))
    .limit(limit);

  const sessions = row.deviceId
    ? await db
        .select({
          id: agentSessions.id,
          title: agentSessions.title,
          status: agentSessions.status,
          failureReason: agentSessions.failureReason,
          updatedAt: agentSessions.updatedAt,
          errorExcerpt: sql<string | null>`(
            SELECT left(t.content->'value'->>'content', 500)
            FROM agent_session_turns t
            WHERE t.agent_session_id = "agent_sessions"."id"
              AND (t.content->'value'->>'content' ILIKE '%RESULT_ERROR%'
                OR t.content->'value'->>'content' ILIKE '%API Error%')
            ORDER BY (t.content->'value'->>'timestamp')::numeric DESC NULLS LAST
            LIMIT 1
          )`,
        })
        .from(agentSessions)
        .where(
          and(eq(agentSessions.deviceId, row.deviceId), eq(agentSessions.projectId, row.projectId)),
        )
        .orderBy(desc(agentSessions.updatedAt))
        .limit(limit)
    : [];

  return { events, sessions };
}
