/**
 * ISS-652 — Tier 1 alert engine, single source of truth. `computeAlerts` is
 * called by BOTH `admin/alert-routes.ts` (pull, GET /api/admin/alerts) and
 * `admin/alert-sweeper.ts` (push, writes `notifications`) — neither side ever
 * inlines its own alert query, so pull and push cannot drift apart.
 *
 * Every window cutoff is bound SQL-side (`now() - (n::int * interval ...)`);
 * postgres-js cannot serialize a JS `Date` at Bind time (ISS-267). An id list
 * is bound via `sql.join(...IN (...))`, never `= ANY(${jsArray}::uuid[])`,
 * which drizzle expands as a malformed record tuple.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { buildBarrierFragments, resolveGateSettings } from '../jobs/dispatch-gates.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';

export type AdminAlertId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5';
export type AdminAlertStatus = 'ok' | 'warn' | 'crit';
export interface AdminAlertEntity {
  ref: string;
  kind: 'job' | 'project' | 'runner' | 'schedule' | 'integration_binding';
  label: string;
}

export interface AdminAlert {
  id: AdminAlertId;
  key: string;
  status: AdminAlertStatus;
  /** True total, NOT entities.length — entities is capped at ENTITY_LIMIT. */
  count: number;
  detail: string;
  /** ISO of the oldest contributing entity; null when status is 'ok'. */
  since: string | null;
  entities: AdminAlertEntity[];
}

export const ENTITY_LIMIT = 20;
export const DEFAULT_STALE_SECONDS = 600;

export interface AlertQueryOptions {
  staleSeconds?: number;
  now?: Date;
}

const CRIT_STUCK_JOBS = 3;

const STARVED_GRACE_SECONDS = (() => {
  const env = Number(process.env.FORGE_ALERT_STARVED_GRACE_SECONDS);
  return Number.isFinite(env) && env > 0 ? env : 300;
})();
const CRIT_STARVED_PROJECTS = 3;

// cm:hack ISS-654 until:admin-thresholds-config-lands — ratio-based spend-spike thresholds are a placeholder; measured on forge-beta they fire at 3.06x on ordinary hourly swings ($37-$194), so expect near-permanent warn until ISS-654 lands the configurable ceiling
const SPEND_WINDOW_HOURS = (() => {
  const env = Number(process.env.FORGE_ALERT_SPEND_WINDOW_HOURS);
  return Number.isFinite(env) && env > 0 ? env : 1;
})();
const SPEND_WARN_RATIO = (() => {
  const env = Number(process.env.FORGE_ALERT_SPEND_WARN_RATIO);
  return Number.isFinite(env) && env > 0 ? env : 2;
})();
const SPEND_CRIT_RATIO = (() => {
  const env = Number(process.env.FORGE_ALERT_SPEND_CRIT_RATIO);
  return Number.isFinite(env) && env > 0 ? env : 4;
})();
const SPEND_MIN_USD = (() => {
  const env = Number(process.env.FORGE_ALERT_SPEND_MIN_USD);
  return Number.isFinite(env) && env > 0 ? env : 5;
})();

const SCHEDULE_WARN_STREAK = 3;
const SCHEDULE_CRIT_STREAK = 5;
// cm:why a streak on a schedule that has stopped running (disabled, or simply abandoned) would pin A5 at warn forever with no path to resolveNotifications — the window is wide enough for a weekly cadence to still be caught
const SCHEDULE_ACTIVE_WINDOW_HOURS = (() => {
  const env = Number(process.env.FORGE_ALERT_SCHEDULE_ACTIVE_WINDOW_HOURS);
  return Number.isFinite(env) && env > 0 ? env : 24 * 8;
})();
const DELIVERY_MIN_SAMPLE = 5;
const DELIVERY_WARN_RATE = 0.5;
const DELIVERY_CRIT_RATE = 0.8;

// cm:why ONE notification type for all 5 Tier 1 alerts, with the identity carried here in the resolutionKey — five `notificationTypes` values would mean five lockstep edits across schema.ts + contracts + emit.ts for a taxonomy ISS-654 makes configurable anyway, and the bell does not branch on type
export function opsAlertResolutionKey(id: AdminAlertId): string {
  return `ops-alert:${id}`;
}

const STATUS_RANK: Record<AdminAlertStatus, number> = {
  ok: 0,
  warn: 1,
  crit: 2,
};

/** crit beats warn beats ok — for combining several contributors into one alert's overall status. */
export function worstStatus(a: AdminAlertStatus, b: AdminAlertStatus): AdminAlertStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A2 classification: 'ok' when nothing is stuck; 'crit' at CRIT_STUCK_JOBS or when the oldest offender has waited 4x the stale threshold; 'warn' otherwise. */
export function classifyStuck(
  count: number,
  oldestAgeSeconds: number,
  staleSeconds: number,
): AdminAlertStatus {
  if (count === 0) return 'ok';
  if (count >= CRIT_STUCK_JOBS || oldestAgeSeconds > staleSeconds * 4) return 'crit';
  return 'warn';
}

/** A4 classification: ratio of current window vs the preceding window, gated by an absolute floor so a near-zero baseline can't fire on noise. */
export function classifySpend(current: number, baseline: number): AdminAlertStatus {
  if (current < SPEND_MIN_USD) return 'ok';
  if (baseline <= 0) return 'warn';
  const ratio = current / baseline;
  if (ratio >= SPEND_CRIT_RATIO) return 'crit';
  if (ratio >= SPEND_WARN_RATIO) return 'warn';
  return 'ok';
}

/** A5 schedule contributor classification: consecutive trailing failures. */
export function classifyScheduleStreak(streak: number): AdminAlertStatus {
  if (streak >= SCHEDULE_CRIT_STREAK) return 'crit';
  if (streak >= SCHEDULE_WARN_STREAK) return 'warn';
  return 'ok';
}

/** A5 integration-delivery contributor classification: fail-rate over the minimum sample. */
export function classifyDeliveryFailRate(failed: number, total: number): AdminAlertStatus {
  if (total < DELIVERY_MIN_SAMPLE) return 'ok';
  const rate = failed / total;
  if (rate >= DELIVERY_CRIT_RATE) return 'crit';
  if (rate >= DELIVERY_WARN_RATE) return 'warn';
  return 'ok';
}

function pluralJobs(n: number): string {
  return `${n} job${n === 1 ? '' : 's'}`;
}

type OrphanRow = {
  id: string;
  job_type: string;
  project_slug: string;
  queued_at: PgTimestamp | null;
};

/** A1 — ISS-258 invariant: a non-terminal job under a terminal pipeline_run. Any count > 0 is crit; the invariant is 0. */
async function alertOrphanJobs(): Promise<AdminAlert> {
  const rows = await db.execute<OrphanRow & { total: number }>(sql`
    SELECT j.id, j.type AS job_type, p.slug AS project_slug, j.queued_at,
           count(*) OVER ()::int AS total
    FROM jobs j
    JOIN pipeline_runs r ON r.id = j.pipeline_run_id
    JOIN projects p ON p.id = j.project_id
    WHERE j.status IN ('queued', 'dispatched', 'running')
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

/** A2 — jobs dispatched or running past staleSeconds (AC 5: BOTH statuses, not dispatched alone). */
async function alertStuckJobs(staleSeconds: number): Promise<AdminAlert> {
  // cm:guard age_seconds is float8, never ::int — classifyStuck compares it against staleSeconds * 4, so truncating SQL-side makes a job already past the crit boundary report warn until the next whole second ticks over
  const rows = await db.execute<StuckRow & { total: number }>(sql`
    SELECT j.id, j.type AS job_type, j.dispatched_at,
           extract(epoch FROM (now() - j.dispatched_at))::float8 AS age_seconds,
           count(*) OVER ()::int AS total
    FROM jobs j
    WHERE j.status IN ('dispatched', 'running')
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

/**
 * A3 — a project with jobs that WOULD dispatch except no runner can accept them.
 *
 * Starvation is defined as passing every dispatch barrier EXCEPT runner
 * availability. A job held by project concurrency (project_cap), a `blocks`/
 * `decomposes` dependency, issue-busy, or a retry cooldown is NOT starved — the
 * dispatcher is correctly holding it and it dispatches on its own once the
 * upstream gate clears. Counting those as "no usable runner" is a false positive
 * (e.g. at the default cap of 1, a second issue's job queued behind an actively
 * running one), and a stale trigger is the same story — `jobs/stale-trigger.ts`
 * ends that job, no runner would have helped.
 *
 * To stay drift-free with the real dispatcher, this replays the SSOT gate
 * fragments (`buildBarrierFragments`, the same builder the picker/asserter use)
 * per candidate project — both halves: the barrier predicates AND the
 * `fresh_capable_runners` CTE that decides runner health — then adds the two
 * clauses the picker leaves to `selectRunnerForJob`: the per-job capability
 * match and the per-stage device pool. Those two are why an offered job can
 * still be unplaceable, so leaving them out is how starvation reads `ok`. The
 * candidate pre-filter is a cheap cross-tenant scan, so on healthy data (no old
 * queued jobs) the per-project replay never runs.
 */
async function alertRunnerStarved(): Promise<AdminAlert> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

  const candidates = await db.execute<{ project_id: string; slug: string }>(sql`
    SELECT DISTINCT j.project_id, p.slug
    FROM jobs j
    JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
    JOIN projects p ON p.id = j.project_id
    WHERE j.status = 'queued'
      AND j.type <> 'pm'
      AND pr.status = 'running'
      AND j.queued_at < now() - (${STARVED_GRACE_SECONDS}::int * interval '1 second')
  `);

  const starved: StarvedProject[] = [];
  for (const c of candidates) {
    const { cap, baseStampable } = await resolveGateSettings(c.project_id);
    const { ctes, predicates } = buildBarrierFragments({
      projectIdRef: sql`${c.project_id}`,
      livenessSeconds,
      baseStampable,
    });
    // cm:guard take runner health from the SSOT `fresh_capable_runners` CTE, never a hand-rolled copy of its clauses — the copy that used to live here drifted twice (main added `limit_reason <> 'auth'` and the `provision_status` gate without this file), and each missing clause counts a runner the dispatcher will never use as available, so real starvation reads `ok` and the alert meant to catch a wedged queue is what hides it.
    // cm:edge lockstep -> packages/core/src/runners/select.ts — the `capabilities @>` join is the ONE clause `selectRunnerForJob` applies that the picker's CTE does not, and it must stay: a job no runner is capable of is offered by the picker, rejected by the selector, and spins queued with no gate reason for any UI to show (measured 2026-08-14: 11 jobs across 5 projects sat 6-22 days in exactly that state). Surfacing that is A3's whole reason to exist.
    // cm:guard nullif BEFORE coalesce on requiredCapabilities — `->` on a JSON null yields jsonb 'null', not SQL NULL, so a bare coalesce leaves `@> 'null'` matching nothing and every job carrying `requiredCapabilities: null` reads as starved while dispatcher.ts (`?? {}`) places it fine
    // cm:edge lockstep -> packages/core/src/jobs/stage-overrides.ts — the `pool` lateral reads the per-stage device pool from exactly the path resolveStageOverrides reads, keyed by the job's own `payload.stageStatus`; a pool naming only offline devices wedges a queue with every gate passing, which is the shape A3 exists to name
    // cm:guard compare the pool CASE-INSENSITIVELY and never cast an element to `uuid` — `z.uuid()` accepts uppercase hex and nothing normalizes it, while `::text` on a uuid column always renders lowercase, so a bare text compare matches zero runners here and every runner in runners/select.ts (which binds a parameter against the uuid column, and so parses case-insensitively): a moving queue would read `runner_starved`, and at three such projects A3 goes crit and pages every platform admin. Casting the ELEMENT instead throws on any malformed entry, which 500s the GET and the sweeper swallows into zeros — `lower()` on both sides is the one form with neither failure.
    // cm:guard the pool arm needs BOTH `IS NULL` and `jsonb_typeof(...) <> 'array'`, in that order — no pool configured is SQL NULL, on which `jsonb_typeof` returns NULL, so a typeof-only arm evaluates the whole OR to NULL and every healthy project reads as starved; and an `IS NULL`-only arm lets `jsonb_array_length` THROW on a scalar, which the sweeper's try/catch swallows into zeros while the GET 500s.
    // cm:guard keep BOTH of those clauses: they are the two `selectRunnerForJob` applies that `fresh_capable_runners` does not, so a job can pass every picker gate and still be unplaceable — drop either and genuine starvation reports `ok`
    const rows = await db.execute<{
      queued_count: number;
      oldest_queued_at: PgTimestamp | null;
    }>(sql`
      WITH ${ctes}
      SELECT count(*)::int AS queued_count, min(j.queued_at) AS oldest_queued_at
      FROM jobs j
      LEFT JOIN issues i ON i.id = j.issue_id
      JOIN pipeline_runs r ON r.id = j.pipeline_run_id
      LEFT JOIN LATERAL (
        SELECT p.agent_config -> 'pipelineConfig' -> 'states' -> (j.payload->>'stageStatus') -> 'deviceIds'
                 AS device_ids
        FROM projects p WHERE p.id = j.project_id
      ) pool ON true
      WHERE j.project_id = ${c.project_id}
        AND j.status = 'queued'
        AND j.type <> 'pm'
        AND r.status = 'running'
        AND j.queued_at < now() - (${STARVED_GRACE_SECONDS}::int * interval '1 second')
        AND (j.retry_after_at IS NULL OR j.retry_after_at <= now())
        AND NOT (${predicates.issueBusySession})
        AND NOT (${predicates.issueBusyJob})
        AND NOT (${predicates.staleTrigger})
        AND NOT (${predicates.blockedBy})
        AND NOT (${predicates.decomposeChildrenPending})
        AND (
          j.issue_id::text IN (SELECT issue_id FROM running_ids)
          OR (SELECT COUNT(*) FROM running_ids) < ${cap}
        )
        AND NOT EXISTS (
          SELECT 1 FROM fresh_capable_runners fcr
          JOIN runners rr ON rr.id = fcr.id
          WHERE fcr.in_flight < fcr.cap
            AND rr.capabilities @> coalesce(nullif(j.payload -> 'requiredCapabilities', 'null'::jsonb), '{}'::jsonb)
            AND (
              pool.device_ids IS NULL
              OR jsonb_typeof(pool.device_ids) <> 'array'
              OR jsonb_array_length(pool.device_ids) = 0
              OR lower(rr.device_id::text) IN (
                SELECT lower(e) FROM jsonb_array_elements_text(pool.device_ids) AS e
              )
            )
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
async function alertSpendSpike(now: Date): Promise<AdminAlert> {
  const w = SPEND_WINDOW_HOURS;
  const [[global], projectRows] = await Promise.all([
    db.execute<{ cur: number; base: number }>(sql`
      SELECT
        coalesce(sum(estimated_cost) FILTER (WHERE recorded_at >= now() - (${w}::int * interval '1 hour')), 0)::float AS cur,
        coalesce(sum(estimated_cost) FILTER (
          WHERE recorded_at >= now() - (${w * 2}::int * interval '1 hour')
            AND recorded_at < now() - (${w}::int * interval '1 hour')
        ), 0)::float AS base
      FROM usage_records
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
  ]);

  const globalStatus = classifySpend(global?.cur ?? 0, global?.base ?? 0);
  const overProjects = projectRows
    .map((r) => ({ ...r, status: classifySpend(r.cur, r.base) }))
    .filter((r) => r.status !== 'ok')
    .sort((a, b) => b.cur - a.cur);

  const status = overProjects.reduce((acc, r) => worstStatus(acc, r.status), globalStatus);
  const windowStart = new Date(now.getTime() - w * 3_600_000).toISOString();
  // cm:guard count must stay >= 1 whenever status !== 'ok' — a global-only fire (no project individually crosses the ratio) still counts 1: the deployment. A consumer filtering on count > 0 must never silently drop a live spend spike.
  const count = status === 'ok' ? 0 : Math.max(overProjects.length, 1);

  return {
    id: 'A4',
    key: 'spend_spike',
    status,
    count,
    detail:
      status === 'ok'
        ? 'No spend spike'
        : `Spend is $${(global?.cur ?? 0).toFixed(2)} this window vs $${(global?.base ?? 0).toFixed(2)} baseline`,
    since: status === 'ok' ? null : windowStart,
    entities: overProjects.slice(0, ENTITY_LIMIT).map((r) => ({
      ref: r.project_id,
      kind: 'project',
      label: `${r.slug} · $${r.cur.toFixed(2)} vs $${r.base.toFixed(2)}`,
    })),
  };
}

// cm:guard postgres-js hands `timestamptz` back as a JS Date, never a string — never compare one of these directly (a bare `.sort()` orders by weekday name); go through `oldestIso` below
type PgTimestamp = string | Date;

type ScheduleStreakRow = {
  schedule_id: string;
  name: string;
  project_id: string;
  project_slug: string;
  streak: number;
  streak_started_at: PgTimestamp | null;
};

type DeliveryFailRow = {
  binding_id: string;
  provider: string;
  project_id: string;
  project_slug: string;
  failed: number;
  total: number;
  oldest_failed_at: PgTimestamp | null;
};

function oldestIso(values: Array<PgTimestamp | null>): string | null {
  let oldest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/** A5 — two contributors combined into one alert: schedule fail-streaks and integration-delivery fail-rates. */
async function alertAutomationFailing(): Promise<AdminAlert> {
  const [scheduleRows, deliveryRows] = await Promise.all([
    // cm:why no LIMIT here — `count` is documented as the true contributor total, so capping in SQL would understate it past ENTITY_LIMIT streaking schedules; only the display `entities` list is truncated
    // cm:why the enabled + last_run_at gate is what lets A5 reach 'ok' again — a streak on a schedule nobody runs any more never clears on its own
    db.execute<ScheduleStreakRow>(sql`
      WITH schedule_events AS (
        SELECT schedule_id::text, status = 'success' AS succeeded, created_at
        FROM schedule_runs
        WHERE status IN ('success', 'failed')
        UNION ALL
        SELECT metadata ->> 'scheduleId' AS schedule_id,
               status IN ('completed', 'completed_via_recovery', 'cancelled_stale') AS succeeded,
               updated_at AS created_at
        FROM agent_sessions
        WHERE metadata ->> 'source' = 'schedule.run'
          AND metadata ->> 'scheduleId' IS NOT NULL
          AND status IN ('completed', 'completed_via_recovery', 'cancelled_stale', 'failed')
      ),
      ranked AS (
        SELECT schedule_id, succeeded, created_at,
               row_number() OVER (PARTITION BY schedule_id ORDER BY created_at DESC) AS rn
        FROM schedule_events
      ),
      first_success AS (
        SELECT schedule_id, min(rn) AS first_success_rn
        FROM ranked
        WHERE succeeded
        GROUP BY schedule_id
      ),
      totals AS (
        SELECT schedule_id, count(*) AS total_runs, max(created_at) AS last_run_at
        FROM ranked GROUP BY schedule_id
      ),
      streaks AS (
        SELECT t.schedule_id, t.last_run_at,
               coalesce(fs.first_success_rn - 1, t.total_runs)::int AS streak
        FROM totals t
        LEFT JOIN first_success fs ON fs.schedule_id = t.schedule_id
      )
      SELECT s.id AS schedule_id, s.name, s.project_id, p.slug AS project_slug, st.streak,
             (SELECT min(r2.created_at) FROM ranked r2 WHERE r2.schedule_id = s.id::text AND r2.rn <= st.streak) AS streak_started_at
      FROM streaks st
      JOIN schedules s ON s.id::text = st.schedule_id
      JOIN projects p ON p.id = s.project_id
      WHERE st.streak >= ${SCHEDULE_WARN_STREAK}
        AND s.enabled = true
        AND st.last_run_at >= now() - (${SCHEDULE_ACTIVE_WINDOW_HOURS}::int * interval '1 hour')
      ORDER BY st.streak DESC
    `),
    // cm:why no LIMIT here — classification (below) must see every qualifying binding, or a low-volume/high-rate binding can be excluded while a high-volume/low-rate one survives
    // cm:edge contract -> packages/core/src/integrations/deliveries.ts — direction='outbound' mirrors that module's outbound-only delivery health filtering; inbound webhook rows are recorded 'ok' by Coolify even on a reported deploy failure
    db.execute<DeliveryFailRow>(sql`
      SELECT b.id AS binding_id, b.provider, b.project_id, p.slug AS project_slug,
             count(*) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(*)::int AS total,
             min(d.created_at) FILTER (WHERE d.status = 'failed') AS oldest_failed_at
      FROM integration_bindings b
      JOIN integration_deliveries d ON d.binding_id = b.id AND d.direction = 'outbound'
      JOIN projects p ON p.id = b.project_id
      WHERE d.status IN ('ok', 'failed')
        AND d.created_at >= now() - interval '1 hour'
      GROUP BY b.id, b.provider, b.project_id, p.slug
      HAVING count(*) >= ${DELIVERY_MIN_SAMPLE}
    `),
  ]);

  const scheduleContributors = scheduleRows.map((r) => ({
    entity: {
      ref: r.schedule_id,
      kind: 'schedule' as const,
      label: `${r.name} · ${r.streak} in a row`,
    },
    status: classifyScheduleStreak(r.streak),
    since: r.streak_started_at,
  }));
  const deliveryContributors = deliveryRows
    .map((r) => ({
      entity: {
        ref: r.binding_id,
        kind: 'integration_binding' as const,
        label: `${r.provider} · ${r.project_slug} · ${r.failed}/${r.total} failed`,
      },
      status: classifyDeliveryFailRate(r.failed, r.total),
      since: r.oldest_failed_at,
    }))
    .filter((r) => r.status !== 'ok');

  // cm:guard status/count are computed over ALL contributors before ENTITY_LIMIT truncation below; the sort keeps a truncation from ever dropping a more-severe row
  const contributors = [...scheduleContributors, ...deliveryContributors].sort(
    (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status],
  );
  const status = contributors.reduce(
    (acc, c) => worstStatus(acc, c.status),
    'ok' as AdminAlertStatus,
  );
  const since = oldestIso(contributors.map((c) => c.since));

  return {
    id: 'A5',
    key: 'automation_failing',
    status,
    count: contributors.length,
    detail:
      contributors.length > 0
        ? `${contributors.length} automation${contributors.length === 1 ? '' : 's'} failing (schedules or integration deliveries)`
        : 'No automation failures',
    since,
    entities: contributors.slice(0, ENTITY_LIMIT).map((c) => c.entity),
  };
}

/** Always returns exactly 5 items, ordered A1..A5. Shared by the pull route and the push sweeper. */
export async function computeAlerts(opts: AlertQueryOptions = {}): Promise<AdminAlert[]> {
  const staleSeconds = opts.staleSeconds ?? DEFAULT_STALE_SECONDS;
  const now = opts.now ?? new Date();
  const [a1, a2, a3, a4, a5] = await Promise.all([
    alertOrphanJobs(),
    alertStuckJobs(staleSeconds),
    alertRunnerStarved(),
    alertSpendSpike(now),
    alertAutomationFailing(),
  ]);
  return [a1, a2, a3, a4, a5];
}
