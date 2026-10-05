import {
  LIVE_PIPELINE_RUN_STATUSES,
  TERMINAL_PIPELINE_RUN_STATUSES,
} from '@forge/contracts/run-machine';
import {
  RUN_EVENTS_MAX,
  RUN_LIVE_STATES,
  RUN_STUCK_AFTER_MS,
  type RunActorType,
  type RunAttemptRow,
  type RunEvent,
  type RunEventEntity,
  type RunLiveState,
  type RunStanding,
  type RunStandingDetail,
  type RunStandingList,
  type RunStandingScope,
} from '@forge/contracts/run-standing';
import { needsViewer } from '@forge/contracts/standing';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { SESSION_SILENCE_TIMEOUT_MS } from '../devices/index.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import {
  gateReasonsForQueuedJobsIn,
  getLoopThresholds,
  killGraceMs,
  RESULT_QUIET_MINUTES,
} from '../jobs/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readMasterStanding } from '../masters/read.js';
import { holds } from '../permissions/index.js';
import { BASE_COLUMNS, type BaseRun, gatherFacts, MASTER_RUN_SQL, RUN_SCOPE_SQL } from './facts.js';
import { runStandingOf, type StandingContext } from './standing.js';

interface RunViewer {
  userId: string;
}

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const inList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
const LIVE_SQL = sql`r.status IN (${inList(LIVE_PIPELINE_RUN_STATUSES)})`;
const SCOPE_SQL: Record<RunStandingScope, SQL> = {
  live: LIVE_SQL,
  finished: sql`r.status IN (${inList(TERMINAL_PIPELINE_RUN_STATUSES)})`,
  all: sql`true`,
};

const SCOPE_RULE =
  'scope reads the pipeline run status: live is running or paused, finished is completed, failed or cancelled; a run whose own status is still live while its root ended is served under live as stuck, rule disagreement (run-live-root-ended)';

async function viewerOf(viewer: RunViewer | null, projectId: string) {
  if (!viewer) return null;
  const [access, people] = await Promise.all([
    effectiveProjectRole(viewer.userId, projectId),
    peopleOf([viewer.userId]),
  ]);
  // A person's wait addresses its viewer as "You" only when the viewer is a person.
  const person = people.get(viewer.userId)?.kind !== 'agent';
  return {
    canWrite: person && access !== null && holds(access, 'project.write'),
    isAdmin: person && access !== null && holds(access, 'project.admin'),
  };
}

async function contextFor(projectId: string, viewer: RunViewer | null) {
  const [master, who, queuedGates] = await Promise.all([
    readMasterStanding(projectId),
    viewerOf(viewer, projectId),
    gateReasonsForQueuedJobsIn([projectId]),
  ]);
  const slots =
    master.slots && master.slots.max !== null
      ? { inUse: master.slots.inUse, max: master.slots.max }
      : null;
  const ctx: StandingContext = {
    now: new Date(),
    viewer: who,
    slots,
    stuckAfterMs: RUN_STUCK_AFTER_MS,
    queuedGates,
    silenceReapMs: SESSION_SILENCE_TIMEOUT_MS,
    jobHeartbeatMs: getLoopThresholds().heartbeatMs,
    jobAckMs: getLoopThresholds().ackMs,
    jobQueueMs: getLoopThresholds().queueMs,
    resultQuietMs: RESULT_QUIET_MINUTES * 60_000,
    killGraceMs: killGraceMs(),
  };
  return { master, ctx };
}

async function baseRuns(
  projectId: string,
  where: SQL,
  limit: number,
  offset: number,
): Promise<BaseRun[]> {
  return rowsOf<BaseRun>(
    await db.execute(sql`
      SELECT ${BASE_COLUMNS}
        FROM pipeline_runs r LEFT JOIN issues i ON i.id = r.issue_id
       WHERE r.project_id = ${projectId} AND ${RUN_SCOPE_SQL} AND ${where}
       ORDER BY r.started_at DESC, r.id
       LIMIT ${limit} OFFSET ${offset}`),
  );
}

async function standingsOf(
  projectId: string,
  base: BaseRun[],
  ctx: StandingContext,
): Promise<RunStanding[]> {
  const prefix = await activeIssuePrefix(projectId);
  const facts = await gatherFacts(prefix, base);
  return facts.map((f) => runStandingOf(f, ctx));
}

async function countsOf(projectId: string) {
  const [row] = rowsOf<{ live: number; finished: number; interactive: number; masters: number }>(
    await db.execute(sql`
      SELECT count(*) FILTER (WHERE ${RUN_SCOPE_SQL} AND ${LIVE_SQL})::int AS live,
             count(*) FILTER (WHERE ${RUN_SCOPE_SQL} AND NOT (${LIVE_SQL}))::int AS finished,
             count(*) FILTER (WHERE r.kind = 'interactive')::int AS interactive,
             count(*) FILTER (WHERE r.kind <> 'interactive' AND ${MASTER_RUN_SQL})::int AS masters
        FROM pipeline_runs r WHERE r.project_id = ${projectId}`),
  );
  return row ?? { live: 0, finished: 0, interactive: 0, masters: 0 };
}

export async function listRunStanding(
  projectId: string,
  opts: { scope: RunStandingScope; limit: number; offset: number },
  viewer: RunViewer | null,
): Promise<RunStandingList> {
  const { master, ctx } = await contextFor(projectId, viewer);
  const [counts, page, liveBase] = await Promise.all([
    countsOf(projectId),
    baseRuns(projectId, SCOPE_SQL[opts.scope], opts.limit + 1, opts.offset),
    baseRuns(projectId, LIVE_SQL, 10_000, 0),
  ]);
  const [items, live] = await Promise.all([
    standingsOf(projectId, page.slice(0, opts.limit), ctx),
    standingsOf(projectId, liveBase, ctx),
  ]);
  const liveByState = Object.fromEntries(RUN_LIVE_STATES.map((s) => [s, 0])) as Record<
    RunLiveState,
    number
  >;
  for (const r of live) {
    if ((RUN_LIVE_STATES as readonly string[]).includes(r.state))
      liveByState[r.state as RunLiveState] += 1;
  }
  const total =
    opts.scope === 'live'
      ? counts.live
      : opts.scope === 'finished'
        ? counts.finished
        : counts.live + counts.finished;
  return {
    generatedAt: ctx.now.toISOString(),
    projectId,
    scope: opts.scope,
    scopeRule: SCOPE_RULE,
    items,
    total,
    limit: opts.limit,
    offset: opts.offset,
    hasMore: page.length > opts.limit,
    counts: {
      live: counts.live,
      finished: counts.finished,
      liveByState,
      needsViewer: live.filter(needsViewer).length,
      held: live.filter((r) => r.holder.source === 'held').length,
    },
    excluded: [
      {
        what: 'interactive',
        count: counts.interactive,
        rule: "a chat's one-shot run is a conversation with a person, not an agent run",
      },
      {
        what: 'master',
        count: counts.masters,
        rule: "a resident master's own run is the master; `master` beside the list serves it from masters/standing",
      },
    ],
    master,
  };
}

async function eventsOf(run: RunStanding): Promise<{ events: RunEvent[]; hasMore: boolean }> {
  const arms: SQL[] = [sql`(entity = 'run' AND entity_id = ${run.id}::uuid)`];
  if (run.sessionId) arms.push(sql`(entity = 'session' AND entity_id = ${run.sessionId}::uuid)`);
  if (run.job) arms.push(sql`(entity = 'job' AND entity_id = ${run.job.id}::uuid)`);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT id, entity, from_status, to_status, reason, actor_type, actor_agency, actor_id, source, created_at
        FROM kernel_transitions
       WHERE ${sql.join(arms, sql` OR `)}
       ORDER BY created_at, id
       LIMIT ${RUN_EVENTS_MAX + 1}`),
  );
  const users = rows.flatMap((r) =>
    r.actor_type === 'user' && r.actor_id ? [String(r.actor_id)] : [],
  );
  const names = await peopleOf(users);
  const events = rows.slice(0, RUN_EVENTS_MAX).map(
    (r): RunEvent => ({
      id: String(r.id),
      at: new Date(String(r.created_at)).toISOString(),
      entity: r.entity as RunEventEntity,
      from: r.from_status == null ? null : String(r.from_status),
      to: String(r.to_status),
      reason: r.reason == null ? null : String(r.reason),
      actor: {
        type: r.actor_type as RunActorType,
        agency: r.actor_agency === 'human' ? 'human' : 'agent',
        name:
          r.actor_type === 'user' && r.actor_id
            ? (names.get(String(r.actor_id))?.name ?? null)
            : null,
      },
      source: String(r.source),
    }),
  );
  return { events, hasMore: rows.length > RUN_EVENTS_MAX };
}

export async function readRunStanding(
  projectId: string,
  runId: string,
  viewer: RunViewer | null,
): Promise<RunStandingDetail | null> {
  const [one] = await baseRuns(projectId, sql`r.id = ${runId}::uuid`, 1, 0);
  if (!one) return null;
  const { ctx } = await contextFor(projectId, viewer);
  const [run] = await standingsOf(projectId, [one], ctx);
  if (!run) return null;
  let attempts: RunAttemptRow[] = [];
  if (run.attempt.source === 'runs') {
    const of = run.attempt.of;
    const seq = Number.parseInt(of.replace(/^[A-Za-z]+-/, ''), 10);
    const siblings = await baseRuns(
      projectId,
      sql`(i.iss_seq = ${seq} OR r.metadata -> 'runGroup' ->> 0 = ${canonicalIssueKey(seq)})`,
      200,
      0,
    );
    const standings = await standingsOf(projectId, siblings, ctx);
    attempts = standings
      .filter((s) => s.attempt.source === 'runs' && s.attempt.of === of)
      .map((s) => ({
        id: s.id,
        n: s.attempt.source === 'runs' ? s.attempt.n : 0,
        state: s.state,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      }))
      .sort((a, b) => b.n - a.n);
  }
  const { events, hasMore } = await eventsOf(run);
  return { generatedAt: ctx.now.toISOString(), run, attempts, events, eventsHasMore: hasMore };
}
