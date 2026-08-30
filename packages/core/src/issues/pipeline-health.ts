/**
 * ISS-164 (D4 of ISS-141) — pipelineHealth derived field + WS broadcast.
 *
 * Single server-side source of truth for per-issue gate state. Loader runs a
 * live join over `issues + jobs + pipeline_runs + agent_sessions +
 * issue_dependencies`, plus the picker's own `fresh_capable_runners` CTE
 * (`freshRunnerAvailability`), and mirrors EVERY arm of the dispatch CASE in
 * `jobs/dispatch-gates.ts`. A gate with no arm here renders as an idle,
 * actionable issue. `jobs.gate_reason` is deliberately NOT read: this layer
 * must stay correct after ISS-162 (D1) drops the column, and reading it would
 * mask the 29-min plan-stage UI blind spot from ISS-137.
 *
 * WS event `issue.pipelineHealth.changed` is published directly (NOT routed
 * through `pipeline/hooks.ts` -> `ws/broadcast-subscribers.ts`) because the
 * payload is a derived snapshot recomputed at publish time — the same pattern
 * `issue.statusChanged` uses. Keep it direct.
 *
 * `lastTickAt` comes from the in-memory map below, so on multi-process deploys
 * clients on another process see stale liveness (closed by ISS-163's probe).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  type IssueStatus,
  issueDependencies,
  issues,
  jobs,
  pipelineRuns,
  runners,
} from '../db/schema.js';
import { freshRunnerAvailability, resolveGateSettings } from '../jobs/dispatch-gates.js';
import { extractStageStatus } from '../jobs/stage-overrides.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { isBlockerSatisfied } from './dependency-satisfaction.js';
import {
  heldWaitingOn,
  retryCooldownWaitingOn,
  runnerWaitingOn,
  staleTriggerWaitingOn,
} from './pipeline-health-reasons.js';
import type {
  ClassifyInput,
  PipelineHealth,
  PipelineHealthDecompChild,
  PipelineHealthDep,
  PipelineHealthJob,
  PipelineHealthRunnerSat,
  PipelineHealthSession,
} from './pipeline-health-types.js';

// cm:edge contract -> packages/core/src/issues/pipeline-health-types.ts — every consumer imports these names from THIS path, so the re-export is the public surface; dropping it moves the break to eleven call sites rather than one
export type {
  ClassifyInput,
  PipelineHealth,
  PipelineHealthDecompChild,
  PipelineHealthDep,
  PipelineHealthJob,
  PipelineHealthRunnerSat,
  PipelineHealthSession,
  PipelineWaitingReason,
  WaitingCause,
} from './pipeline-health-types.js';

/**
 * Per-project in-memory dispatcher heartbeat. Set by `recordTickAt` from
 * `jobs/dispatch-tick.ts` at the top of each sweep; surfaced to clients via
 * `PipelineHealth.lastTickAt`. Multi-process caveat: each process keeps its
 * own map (no Redis/pg backing). ISS-163 (D2) closes the gap.
 */
const lastTickAtByProject = new Map<string, Date>();

export function recordTickAt(projectId: string, at: Date = new Date()): void {
  lastTickAtByProject.set(projectId, at);
}

export function getLastTickAt(projectId: string): Date | null {
  return lastTickAtByProject.get(projectId) ?? null;
}

export function resetLastTickAtForTest(): void {
  lastTickAtByProject.clear();
}

/**
 * Q3 — the issue's live jobs, bucketed by issue id.
 */
// cm:guard `held` MUST be loaded here but MUST NOT be counted at the runner-in-flight query in the loader below — this feeds the `issue_busy` and `job_held` reasons, which mirror L1 `issueBusyJob` (held blocks a duplicate), while that query mirrors `runner_load` (held burns no cap). Drop it here and the gate refuses to dispatch while pipelineHealth reports no waitingOn at all — the exact lie this file's lockstep edge exists to prevent.
async function loadActiveJobsByIssue(
  projectId: string,
  ids: string[],
): Promise<Map<string, PipelineHealthJob[]>> {
  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      runnerId: jobs.runnerId,
      agentSessionId: jobs.agentSessionId,
      issueId: jobs.issueId,
      failureReason: jobs.failureReason,
      pipelineRunStatus: pipelineRuns.status,
      payload: jobs.payload,
      retryAfterAt: jobs.retryAfterAt,
    })
    .from(jobs)
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, jobs.pipelineRunId))
    .where(
      and(
        eq(jobs.projectId, projectId),
        inArray(jobs.issueId, ids),
        inArray(jobs.status, ['queued', 'dispatched', 'running', 'held']),
      ),
    );
  const byIssue = new Map<string, PipelineHealthJob[]>();
  for (const r of rows) {
    if (!r.issueId) continue;
    const bucket = byIssue.get(r.issueId) ?? [];
    bucket.push({
      id: r.id,
      type: r.type,
      status: r.status,
      queuedAt: r.queuedAt,
      runnerId: r.runnerId,
      agentSessionId: r.agentSessionId,
      failureReason: r.failureReason,
      pipelineRunStatus: r.pipelineRunStatus,
      stageStatus: extractStageStatus(r.payload),
      retryAfterAt: r.retryAfterAt,
    });
    byIssue.set(r.issueId, bucket);
  }
  return byIssue;
}

/**
 * Pure classifier — given pre-fetched rows for a single issue, decide its
 * `PipelineHealth`. Kept separate from the SQL loader so unit tests can
 * exercise each L1..L4 branch without mocking drizzle. The loader composes
 * this for every requested issue id.
 */
export function classifyPipelineHealthForIssue(input: ClassifyInput): PipelineHealth {
  const {
    issue,
    sessions,
    jobs: issueJobs,
    deps,
    decompChildren,
    runningIssueIds,
    runningIssueCount,
    cap,
    baseStampable,
    runnerInFlight,
    runnerPool,
    lastTickAt,
  } = input;

  const queuedJobs = issueJobs.filter((j) => j.status === 'queued');
  const activeJobs = issueJobs.filter((j) => j.status !== 'queued');
  const activeSession = sessions.find((s) => s.status === 'running' || s.status === 'queued');

  const out: PipelineHealth = { stage: issue.status as IssueStatus };
  if (activeSession) {
    out.activeSession = {
      id: activeSession.id,
      status: activeSession.status as 'queued' | 'running',
      skill: skillFromSessionMetadata(activeSession.metadata),
    };
  }
  if (lastTickAt) out.lastTickAt = lastTickAt.toISOString();

  if (issue.status === 'waiting' && issue.waitingKind) {
    out.waitingCause = { kind: issue.waitingKind };
  }

  // cm:guard this call MUST stay above the `queuedJobs.length === 0` return — a held job is usually the issue's ONLY job, so deriving it from inside the queued-candidate block below reports nothing at all in exactly the case that matters
  const held = heldWaitingOn(issueJobs);
  if (held) {
    out.waitingOn = held;
    return out;
  }

  if (queuedJobs.length === 0) return out;

  const candidate = [...queuedJobs].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())[0];
  if (!candidate) return out;
  const sinceIso = candidate.queuedAt.toISOString();
  out.queuedAt = sinceIso;

  // cm:guard this arm belongs FIRST among the queued reasons, matching the CASE in dispatch-gates.ts — a paused or terminal parent run makes every later gate moot, and reporting `project_full` or `runner_full` for it sends the reader after a slot that would change nothing
  if (candidate.pipelineRunStatus && candidate.pipelineRunStatus !== 'running') {
    out.waitingOn = {
      reason: 'run_not_running',
      since: sinceIso,
      details: { runStatus: candidate.pipelineRunStatus, queuedJobId: candidate.id },
    };
    return out;
  }

  // cm:guard the cooldown arm belongs HERE, third, exactly where `retry_cooldown` sits in the dispatch CASE — ahead of both issue_busy arms and of staleness. Until ISS-789 the reason had no member in `PipelineWaitingReason` at all, so every cooldown-gated job rendered as an idle, actionable issue while the picker was refusing it.
  const cooldown = retryCooldownWaitingOn(candidate, sinceIso, input.now ?? new Date());
  if (cooldown) {
    out.waitingOn = cooldown;
    return out;
  }

  const blockingSession = sessions.find(
    (s) => (s.status === 'running' || s.status === 'queued') && s.id !== candidate.agentSessionId,
  );
  const blockingJob = activeJobs.find((j) => j.id !== candidate.id);
  // cm:guard the session arm stays FIRST — with both present this reason reports the session and never the job, which is what the `if (blockingSession || blockingJob)` guard plus a ternary meant. Narrowing `blockingJob` with `&&` rather than asserting it with `!` is not style: TypeScript cannot narrow across that guard, so the two assertions were the compiler's blindness written as a claim, and `a!.b` is the one thing biome's autofix turns into `a?.b` — "throw when the invariant is violated" becoming "silently undefined".
  const busy = blockingSession
    ? { blockingSessionId: blockingSession.id }
    : blockingJob && { blockingJobId: blockingJob.id, blockingJobType: blockingJob.type };
  if (busy) {
    out.waitingOn = { reason: 'issue_busy', since: sinceIso, details: busy };
    return out;
  }

  // cm:guard this arm must sit exactly where `stale_trigger` sits in the dispatch CASE — after both issue_busy arms, before blocked_by. Reporting it earlier would claim a job is stale during the one window where a non-trigger status is legitimate (a sibling step mid-flight), and omitting it renders the issue idle-and-actionable for the up-to-a-tick window before `jobs/stale-trigger.ts` discards the job.
  const stale = staleTriggerWaitingOn(candidate, issue.status, sinceIso);
  if (stale) {
    out.waitingOn = stale;
    return out;
  }

  const blockers = deps.filter(
    (d) =>
      d.kind === 'blocks' &&
      !isBlockerSatisfied({ status: d.fromStatus, mergedAt: d.fromMergedAt }, baseStampable),
  );
  if (blockers.length > 0) {
    const closedUnmerged = blockers.filter((b) => b.fromStatus === 'closed');
    out.waitingOn = {
      reason: 'waiting_on_dep',
      since: sinceIso,
      details: {
        blockerIssueIds: blockers.map((b) => b.fromIssueId),
        // Called out separately: these need an operator decision
        // (mark_merged or reopen), waiting will not resolve them.
        ...(closedUnmerged.length > 0
          ? { closedUnmergedBlockerIssueIds: closedUnmerged.map((b) => b.fromIssueId) }
          : {}),
      },
    };
    return out;
  }

  // Gate `decomposeChildrenPending`: a decompose PARENT's forward jobs wait
  // for every child to land. (The old inverse rule — child release waiting on
  // its parent — was removed from the gate; it deadlocked umbrella epics.)
  if (['code', 'review', 'test', 'fix'].includes(candidate.type)) {
    const pendingChildren = decompChildren.filter((c) => !isBlockerSatisfied(c, baseStampable));
    if (pendingChildren.length > 0) {
      out.waitingOn = {
        reason: 'waiting_on_decomp_children',
        since: sinceIso,
        details: { childIssueIds: pendingChildren.map((c) => c.childIssueId) },
      };
      return out;
    }
  }

  if (runningIssueCount >= cap && !runningIssueIds.has(issue.id)) {
    out.waitingOn = {
      reason: 'project_full',
      since: sinceIso,
      details: { cap, running: [...runningIssueIds] },
    };
    return out;
  }

  const runnerWait = runnerWaitingOn(candidate, sinceIso, runnerInFlight, runnerPool);
  if (runnerWait) {
    out.waitingOn = runnerWait;
    return out;
  }

  return out;
}

function skillFromSessionMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  const skill = metadata.skill;
  if (typeof skill === 'string') return skill;
  const skillName = metadata.skillName;
  if (typeof skillName === 'string') return skillName;
  return '';
}

function runnerDefaultConcurrency(_runnerType: string): number {
  // ISS-232 Phase 2 — runner cap is unified to 1 across all types. The
  // antigravity 5-slot branch is gone; antigravity-as-load-balancer is
  // replaced by primary-pinned selection (see runners/select.ts).
  return 1;
}

/**
 * Q6 — in-flight load on the runners that queued candidates are pinned to.
 * Empty when no candidate has a `runner_id` (nothing to be saturated).
 */
// cm:guard count only `dispatched|running` here — this mirrors the gate's `runner_load` CTE, where `held` is deliberately absent because a held job has released its slot; adding it reports `runner_full` for a runner that is in fact free
async function loadPinnedRunnerSaturation(
  jobsByIssue: ReadonlyMap<string, PipelineHealthJob[]>,
): Promise<Map<string, PipelineHealthRunnerSat>> {
  const candidateRunnerIds = new Set<string>();
  for (const list of jobsByIssue.values()) {
    for (const j of list) {
      if (j.status === 'queued' && j.runnerId) candidateRunnerIds.add(j.runnerId);
    }
  }
  const out = new Map<string, PipelineHealthRunnerSat>();
  if (candidateRunnerIds.size === 0) return out;

  const ids = [...candidateRunnerIds];
  const runnerRows = await db
    .select({ id: runners.id, type: runners.type, capabilities: runners.capabilities })
    .from(runners)
    .where(inArray(runners.id, ids));
  const inFlightRows = await db
    .select({ runnerId: jobs.runnerId, count: sql<string>`COUNT(*)::text` })
    .from(jobs)
    .where(and(inArray(jobs.runnerId, ids), inArray(jobs.status, ['dispatched', 'running'])))
    .groupBy(jobs.runnerId);

  const inFlightByRunner = new Map<string, number>();
  for (const r of inFlightRows) {
    if (r.runnerId) inFlightByRunner.set(r.runnerId, Number(r.count));
  }
  for (const r of runnerRows) {
    const caps = (r.capabilities ?? {}) as Record<string, unknown>;
    const cap =
      typeof caps.maxConcurrent === 'number' && caps.maxConcurrent > 0
        ? caps.maxConcurrent
        : runnerDefaultConcurrency(r.type);
    out.set(r.id, { type: r.type, cap, inFlight: inFlightByRunner.get(r.id) ?? 0 });
  }
  return out;
}

export async function hydratePipelineHealthForIssues(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, PipelineHealth>> {
  const map = new Map<string, PipelineHealth>();
  if (issueIds.length === 0) return map;
  const ids = [...issueIds];

  // Q1 — issue rows.
  const issueRows = await db
    .select({
      id: issues.id,
      status: issues.status,
      projectId: issues.projectId,
      mergedAt: issues.mergedAt,
      waitingKind: issues.waitingKind,
    })
    .from(issues)
    .where(inArray(issues.id, ids));
  const issuesById = new Map(issueRows.map((r) => [r.id, r]));

  // Q2 — non-idle agent_sessions linked to these issues via metadata.issueId.
  const sessionRows = await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      metadata: agentSessions.metadata,
      issueId: sql<string>`(${agentSessions.metadata}->>'issueId')`,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.status, ['queued', 'running', 'completed', 'failed']),
        inArray(sql<string>`${agentSessions.metadata}->>'issueId'`, ids),
      ),
    )
    .orderBy(sql`updated_at DESC`);
  const sessionsByIssue = new Map<string, PipelineHealthSession[]>();
  for (const r of sessionRows) {
    if (!r.issueId) continue;
    const bucket = sessionsByIssue.get(r.issueId) ?? [];
    bucket.push({
      id: r.id,
      status: r.status,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    });
    sessionsByIssue.set(r.issueId, bucket);
  }

  const jobsByIssue = await loadActiveJobsByIssue(projectId, ids);

  // Q4 — incoming `blocks` edges pointing AT these issues, with the
  // blocker's merged_at (the gate's actual satisfaction key).
  const depRows = await db
    .select({
      toIssueId: issueDependencies.toIssueId,
      fromIssueId: issueDependencies.fromIssueId,
      kind: issueDependencies.kind,
      fromStatus: issues.status,
      fromMergedAt: issues.mergedAt,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.fromIssueId))
    .where(
      and(
        inArray(issueDependencies.toIssueId, ids),
        eq(issueDependencies.kind, 'blocks'),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    );
  const depsByIssue = new Map<string, PipelineHealthDep[]>();
  for (const r of depRows) {
    const bucket = depsByIssue.get(r.toIssueId) ?? [];
    bucket.push({
      fromIssueId: r.fromIssueId,
      kind: r.kind,
      fromStatus: r.fromStatus,
      fromMergedAt: r.fromMergedAt,
    });
    depsByIssue.set(r.toIssueId, bucket);
  }

  // Q4b — outgoing `decomposes` edges FROM these issues (issue = decompose
  // parent, gate `decomposeChildrenPending` waits on the children).
  const decompRows = await db
    .select({
      parentIssueId: issueDependencies.fromIssueId,
      childIssueId: issueDependencies.toIssueId,
      childStatus: issues.status,
      childMergedAt: issues.mergedAt,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.toIssueId))
    .where(
      and(
        inArray(issueDependencies.fromIssueId, ids),
        eq(issueDependencies.kind, 'decomposes'),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    );
  const decompChildrenByIssue = new Map<string, PipelineHealthDecompChild[]>();
  for (const r of decompRows) {
    const bucket = decompChildrenByIssue.get(r.parentIssueId) ?? [];
    bucket.push({
      childIssueId: r.childIssueId,
      status: r.childStatus,
      mergedAt: r.childMergedAt,
    });
    decompChildrenByIssue.set(r.parentIssueId, bucket);
  }

  // Q5 — project_full inputs. The per-project cap defaults to 1 but is
  // operator-tunable via `pipelineConfig.maxConcurrentIssues`; resolve the
  // same values the dispatch picker enforces (cap + baseStampable) so this
  // health card never drifts from actual dispatch behaviour.
  const { cap, baseStampable } = await resolveGateSettings(projectId);
  const runningRows = await db.execute<{ issue_id: string }>(sql`
    SELECT DISTINCT (metadata->>'issueId') AS issue_id
    FROM agent_sessions
    WHERE project_id = ${projectId}
      AND status IN ('queued','running')
      AND (metadata->>'issueId') IS NOT NULL
  `);
  const runningIssueIds = new Set(
    runningRows.map((r) => r.issue_id).filter((v): v is string => Boolean(v)),
  );
  const runningIssueCount = runningIssueIds.size;

  const runnerInFlight = await loadPinnedRunnerSaturation(jobsByIssue);

  const runnerPool = await freshRunnerAvailability(projectId);
  const lastTickAt = getLastTickAt(projectId);

  for (const issueId of ids) {
    const issueRow = issuesById.get(issueId);
    if (!issueRow) continue;
    const health = classifyPipelineHealthForIssue({
      issue: {
        id: issueRow.id,
        status: issueRow.status,
        mergedAt: issueRow.mergedAt,
        waitingKind: issueRow.waitingKind,
      },
      sessions: sessionsByIssue.get(issueId) ?? [],
      jobs: jobsByIssue.get(issueId) ?? [],
      deps: depsByIssue.get(issueId) ?? [],
      decompChildren: decompChildrenByIssue.get(issueId) ?? [],
      runningIssueIds,
      runningIssueCount,
      cap,
      baseStampable,
      runnerInFlight,
      runnerPool,
      lastTickAt,
    });
    map.set(issueId, health);
  }

  return map;
}

export async function publishPipelineHealthChanged(
  projectId: string,
  issueIds: readonly string[],
): Promise<void> {
  if (issueIds.length === 0) return;
  try {
    // Lazy-import ws/server so the loader half of this module (used by the
    // issue REST routes) doesn't pull the websocket + runner-heartbeat graph
    // — which transitively requires pg-boss/DATABASE_URL — into unit tests
    // that mock only the env they need.
    const { roomManager } = await import('../ws/server.js');
    const map = await hydratePipelineHealthForIssues(projectId, issueIds);
    for (const [issueId, pipelineHealth] of map) {
      roomManager.publish(projectRoom(projectId), {
        event: 'issue.pipelineHealth.changed',
        data: { issueId, projectId, pipelineHealth },
      });
    }
  } catch (err) {
    logger.warn({ err, projectId, issueCount: issueIds.length }, 'pipeline-health: publish failed');
  }
}
