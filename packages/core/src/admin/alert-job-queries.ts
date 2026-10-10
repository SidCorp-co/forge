// The alerts read from jobs, runners and spend (ISS-652 A1-A4). Every window cutoff is bound
// SQL-side (`now() - (n::int * interval ...)`): postgres-js cannot serialize a JS `Date` at Bind
// time (ISS-267).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { buildBarrierFragments } from '../jobs/index.js';
import type { AdminThresholds } from '../lib/admin-thresholds.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { runnerMayTakeJob } from '../runners/index.js';
import { type AlertReading, ENTITY_LIMIT, oldestIso, type PgTimestamp } from './alert-reading.js';
import {
  CRIT_STARVED_PROJECTS,
  classifySpend,
  classifySpendCeiling,
  classifyStuck,
  pluralJobs,
  SPEND_WINDOW_HOURS,
  worstStatus,
} from './alert-rules.js';

type OrphanRow = {
  id: string;
  job_type: string;
  project_slug: string;
  queued_at: PgTimestamp | null;
};

/** A1 — ISS-258 invariant: a non-terminal job under a terminal pipeline_run. Any count > 0 is crit; the invariant is 0. */
export async function alertOrphanJobs(): Promise<AlertReading> {
  const rows = await db.execute<OrphanRow & { total: number }>(sql`
    SELECT j.id, j.type AS job_type, p.slug AS project_slug, j.queued_at,
           count(*) OVER ()::int AS total
    FROM jobs j
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    JOIN projects p ON p.id = j.project_id
    WHERE j.status IN ('queued', 'dispatched')
      AND r.status IN ('completed', 'failed', 'cancelled')
    ORDER BY j.queued_at ASC
    LIMIT ${ENTITY_LIMIT}
  `);
  const count = rows[0]?.total ?? 0;
  return {
    id: 'A1',
    key: 'orphan_jobs',
    status: count > 0 ? 'crit' : 'ok',
    count,
    detail:
      count > 0 ? `${pluralJobs(count)} stuck under a terminal pipeline run` : 'No orphan jobs',
    since: oldestIso([rows[0]?.queued_at ?? null]),
    entities: rows.map((r) => ({
      ref: r.id,
      kind: 'job',
      label: `${r.job_type} · ${r.project_slug}`,
    })),
  };
}

type StuckRow = {
  id: string;
  job_type: string;
  dispatched_at: PgTimestamp | null;
  age_seconds: number;
};

/** A2 — jobs dispatched past staleSeconds (a job has no `running` state; its session does). */
export async function alertStuckJobs(staleSeconds: number): Promise<AlertReading> {
  const rows = await db.execute<StuckRow & { total: number }>(sql`
    SELECT j.id, j.type AS job_type, j.dispatched_at,
           extract(epoch FROM (now() - j.dispatched_at))::float8 AS age_seconds,
           count(*) OVER ()::int AS total
    FROM jobs j
    WHERE j.status = 'dispatched'
      AND j.dispatched_at IS NOT NULL
      AND j.dispatched_at < now() - (${staleSeconds}::int * interval '1 second')
    ORDER BY j.dispatched_at ASC
    LIMIT ${ENTITY_LIMIT}
  `);
  const count = rows[0]?.total ?? 0;
  const oldestAgeSeconds = rows[0]?.age_seconds ?? 0;
  return {
    id: 'A2',
    key: 'stuck_jobs',
    status: classifyStuck(count, oldestAgeSeconds, staleSeconds),
    count,
    detail:
      count > 0
        ? `${pluralJobs(count)} dispatched or running past ${staleSeconds}s`
        : 'No stuck jobs',
    since: oldestIso([rows[0]?.dispatched_at ?? null]),
    entities: rows.map((r) => ({
      ref: r.id,
      kind: 'job',
      label: `${r.job_type} · ${Math.round(r.age_seconds / 60)}m`,
    })),
  };
}

type StarvedProject = {
  projectId: string;
  slug: string;
  queuedCount: number;
  oldest: PgTimestamp | null;
};

export async function alertRunnerStarved(starvedGraceSeconds: number): Promise<AlertReading> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

  const candidates = await db.execute<{ project_id: string; slug: string }>(sql`
    SELECT DISTINCT j.project_id, p.slug
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    JOIN projects p ON p.id = j.project_id
    WHERE j.status = 'queued'
      AND pr.status = 'running'
      AND j.queued_at < now() - (${starvedGraceSeconds}::int * interval '1 second')
  `);

  const starved: StarvedProject[] = [];
  for (const c of candidates) {
    const { ctes, predicates } = buildBarrierFragments({
      projectIds: [c.project_id],
      livenessSeconds,
    });
    const rows = await db.execute<{
      queued_count: number;
      oldest_queued_at: PgTimestamp | null;
    }>(sql`
      WITH ${ctes}
      SELECT count(*)::int AS queued_count, min(j.queued_at) AS oldest_queued_at
      FROM jobs j
      LEFT JOIN issues i ON i.id = j.issue_id
      JOIN pipeline_runs r ON r.id = j.pipeline_run_id
      WHERE j.project_id = ${c.project_id}
        AND j.status = 'queued'
          AND r.status = 'running'
        AND j.queued_at < now() - (${starvedGraceSeconds}::int * interval '1 second')
        AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
        AND NOT (${predicates.issueBusySession})
        AND NOT (${predicates.issueBusyJob})
        AND j.held_by IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM fresh_capable_runners fcr
          JOIN runners rr ON rr.id = fcr.id
          WHERE fcr.claim_capable
            AND ${runnerMayTakeJob(sql`rr.labels`)}
            AND rr.capabilities @> coalesce(nullif(j.payload -> 'requiredCapabilities', 'null'::jsonb), '{}'::jsonb)
        )
    `);
    const row = rows[0];
    if (row && row.queued_count > 0) {
      starved.push({
        projectId: c.project_id,
        slug: c.slug,
        queuedCount: row.queued_count,
        oldest: row.oldest_queued_at,
      });
    }
  }

  starved.sort((a, b) => {
    const am = a.oldest
      ? a.oldest instanceof Date
        ? a.oldest.getTime()
        : Date.parse(a.oldest)
      : 0;
    const bm = b.oldest
      ? b.oldest instanceof Date
        ? b.oldest.getTime()
        : Date.parse(b.oldest)
      : 0;
    return am - bm;
  });

  const count = starved.length;
  return {
    id: 'A3',
    key: 'runner_starved',
    status: count >= CRIT_STARVED_PROJECTS ? 'crit' : count >= 1 ? 'warn' : 'ok',
    count,
    detail:
      count > 0
        ? `${count} project${count === 1 ? '' : 's'} queued with no usable runner`
        : 'No starved projects',
    since: oldestIso(starved.map((s) => s.oldest)),
    entities: starved.slice(0, ENTITY_LIMIT).map((s) => ({
      ref: s.projectId,
      kind: 'project',
      label: `${s.slug} · ${s.queuedCount} queued`,
    })),
  };
}

type SpendRow = { project_id: string; slug: string; cur: number; base: number };

/** A4 — current-window spend vs the preceding window of equal length, cross-tenant and per project. */
export async function alertSpendSpike(
  now: Date,
  thresholds: AdminThresholds,
): Promise<AlertReading> {
  const w = SPEND_WINDOW_HOURS;
  const [[global], projectRows, [day]] = await Promise.all([
    db.execute<{ cur: number; base: number }>(sql`
      SELECT
        coalesce(sum(estimated_cost) FILTER (WHERE recorded_at >= now() - (${w}::int * interval '1 hour')), 0)::float AS cur,
        coalesce(sum(estimated_cost) FILTER (
          WHERE recorded_at >= now() - (${w * 2}::int * interval '1 hour')
            AND recorded_at < now() - (${w}::int * interval '1 hour')
        ), 0)::float AS base
      FROM usage_records
      WHERE recorded_at >= now() - (${w * 2}::int * interval '1 hour')
    `),
    db.execute<SpendRow>(sql`
      SELECT p.id AS project_id, p.slug,
        coalesce(sum(u.estimated_cost) FILTER (WHERE u.recorded_at >= now() - (${w}::int * interval '1 hour')), 0)::float AS cur,
        coalesce(sum(u.estimated_cost) FILTER (
          WHERE u.recorded_at >= now() - (${w * 2}::int * interval '1 hour')
            AND u.recorded_at < now() - (${w}::int * interval '1 hour')
        ), 0)::float AS base
      FROM projects p
      JOIN usage_records u ON u.project_id = p.id
        AND u.recorded_at >= now() - (${w * 2}::int * interval '1 hour')
      GROUP BY p.id, p.slug
    `),
    db.execute<{ spend: number }>(sql`
      SELECT coalesce(sum(estimated_cost), 0)::float AS spend
      FROM usage_records
      WHERE recorded_at >= now() - interval '24 hours'
    `),
  ]);

  const spikeMultiple = thresholds.spendSpikeMultiple;
  const globalStatus = classifySpend(global?.cur ?? 0, global?.base ?? 0, spikeMultiple);
  const overProjects = projectRows
    .map((r) => ({ ...r, status: classifySpend(r.cur, r.base, spikeMultiple) }))
    .filter((r) => r.status !== 'ok')
    .sort((a, b) => b.cur - a.cur);

  const spendUsdDay = day?.spend ?? 0;
  const ceiling = thresholds.spendCeilingUsdDay;
  const ceilingStatus = classifySpendCeiling(spendUsdDay, ceiling);
  const ratioStatus = overProjects.reduce((acc, r) => worstStatus(acc, r.status), globalStatus);
  const status = worstStatus(ratioStatus, ceilingStatus);
  const windowStart = new Date(now.getTime() - w * 3_600_000).toISOString();
  const count = status === 'ok' ? 0 : Math.max(overProjects.length, 1);

  const detail =
    status === 'ok'
      ? 'No spend spike'
      : ceiling !== null && worstStatus(ceilingStatus, ratioStatus) === ceilingStatus
        ? `Spend is $${spendUsdDay.toFixed(2)} in 24h against a $${ceiling.toFixed(2)}/day ceiling`
        : `Spend is $${(global?.cur ?? 0).toFixed(2)} this window vs $${(global?.base ?? 0).toFixed(2)} baseline`;

  return {
    id: 'A4',
    key: 'spend_spike',
    status,
    count,
    detail,
    since: status === 'ok' ? null : windowStart,
    entities: overProjects.slice(0, ENTITY_LIMIT).map((r) => ({
      ref: r.project_id,
      kind: 'project',
      label: `${r.slug} · $${r.cur.toFixed(2)} vs $${r.base.toFixed(2)}`,
    })),
  };
}
