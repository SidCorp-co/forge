/**
 * ISS-164 (D4 of ISS-141) — pipelineHealth derived field + WS broadcast.
 *
 * Single server-side source of truth for per-issue gate state. Loader runs a
 * live join over `issues + jobs + pipeline_runs + agent_sessions +
 * issue_dependencies`, plus the picker's own `fresh_capable_runners` CTE
 * (`freshRunnerAvailability`), and mirrors EVERY arm of the dispatch CASE in
 * `jobs/dispatch-gates.ts` — run-not-running, L1..L3, and both L4/L5 runner
 * arms. A gate with no arm here renders as an idle, actionable issue. No
 * persisted gate column is consulted — `jobs.gate_reason` is intentionally
 * NOT read here so this layer stays correct after ISS-162 (D1) eventually
 * drops it (the column is still in the schema today, but reading it would
 * mask the 29-min plan-stage UI blind spot from ISS-137).
 *
 * WS event `issue.pipelineHealth.changed` is published directly (NOT routed
 * through `pipeline/hooks.ts` → `ws/broadcast-subscribers.ts`) because the
 * payload is a derived snapshot recomputed at publish time. Matches the
 * existing direct-publish pattern for `issue.statusChanged` (see
 * `ws/broadcast-subscribers.ts:38`). Future maintainers: keep it direct.
 *
 * `lastTickAt` is sourced from the in-memory map below. On multi-process
 * deploys each process keeps its own copy; clients connected to a different
 * process see stale liveness. Acceptable for v1 — ISS-163 (D2) ships a
 * pg-boss-backed health probe that closes the gap.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  type IssueStatus,
  issueDependencies,
  issues,
  jobs,
  pipelineRuns,
  runners,
  type WaitingKind,
} from '../db/schema.js';
import {
  freshRunnerAvailability,
  type RunnerAvailability,
  resolveGateSettings,
  runnerSupportsJobType,
} from '../jobs/dispatch-gates.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';

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

// cm:guard `job_held` is the ONLY thing that makes RFC 0002 honest — a held job leaves the issue at its stage entry-status, so without this reason the board shows an issue that looks idle and actionable while a step is in fact waiting on a machine. Delete it and you have rebuilt the ambiguity the RFC removed, on the other axis.
// cm:guard every reason the dispatch CASE can return needs a member here, or the issue renders as idle-and-actionable while the picker refuses it — `run_not_running` and `runner_stale` were the two missing ones, and they are the two that never clear on their own: measured 2026-08-14, forge-dev ISS-576/ISS-652 sat under a `paused` run since 08-11 and 11 jobs across 5 projects sat behind dead runners for 6-22 days, all of them showing NO waitingOn at all.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts#buildGateReasonCase — that CASE is the authority on which gates exist; a reason added there and not here is invisible to every UI
export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'waiting_on_dep'
  | 'waiting_on_decomp_children'
  | 'project_full'
  | 'runner_stale'
  | 'runner_full';

/**
 * Why an issue is at `status='waiting'` — AUTHORED by whoever parked it, never
 * derived. Both values mean "a human is needed"; they differ in what the human
 * has to supply.
 */
// cm:guard this is now a pass-through of `issues.waiting_kind`, and it must stay one (RFC 0002 INV-5) — the five-way derivation it replaced read `merged_at`, the decompose-child count and a best-effort jsonb `pauseReason`, and on ISS-163 that jsonb write had silently failed, so a reopen-cap park read back as `merged_parked` and the UI rendered no override button at all. A NULL kind renders generic copy; inferring one is how that bug returns.
export type WaitingCause = WaitingKind;

export interface PipelineHealth {
  stage: IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  lastTickAt?: string;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
}

export interface PipelineHealthSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface PipelineHealthJob {
  id: string;
  type: string;
  status: string;
  queuedAt: Date;
  runnerId: string | null;
  agentSessionId: string | null;
  /** The hold reason when `status === 'held'` (`jobs/hold.ts`). */
  failureReason?: string | null;
  /** Parent `pipeline_runs.status`. The picker requires `running`. */
  pipelineRunStatus?: string | null;
}

export interface PipelineHealthDep {
  fromIssueId: string;
  kind: string;
  fromStatus: string;
  /** Blocker's `issues.merged_at` — the L2 gate keys on this, not status. */
  fromMergedAt: Date | null;
}

/** Outgoing `kind='decomposes'` edge: this issue is the decompose PARENT and
 *  its forward jobs wait for every child to land (gate
 *  `decomposeChildrenPending`). */
export interface PipelineHealthDecompChild {
  childIssueId: string;
  status: string;
  mergedAt: Date | null;
}

export interface PipelineHealthRunnerSat {
  type: string;
  cap: number;
  inFlight: number;
}

export interface ClassifyInput {
  issue: { id: string; status: string; mergedAt: Date | null; waitingKind: WaitingKind | null };
  sessions: PipelineHealthSession[];
  jobs: PipelineHealthJob[];
  deps: PipelineHealthDep[];
  decompChildren: PipelineHealthDecompChild[];
  runningIssueIds: ReadonlySet<string>;
  runningIssueCount: number;
  cap: number;
  /** From `resolveGateSettings` — when the base merge state can never stamp
   *  `merged_at`, the gate honors `status='closed'` as satisfaction. */
  baseStampable: boolean;
  runnerInFlight: ReadonlyMap<string, PipelineHealthRunnerSat>;
  /** From `freshRunnerAvailability` — the picker's own runner-pool counts. */
  runnerPool: RunnerAvailability;
  lastTickAt: Date | null;
}

/** The `job_held` waitingOn for an issue with a held job, or `null`. */
function heldWaitingOn(issueJobs: PipelineHealthJob[]): PipelineHealth['waitingOn'] {
  const held = issueJobs.find((j) => j.status === 'held');
  if (!held) return undefined;
  return {
    reason: 'job_held',
    since: held.queuedAt.toISOString(),
    details: {
      heldJobId: held.id,
      heldJobType: held.type,
      holdReason: held.failureReason ?? null,
    },
  };
}

/** The runner-layer (L4/L5) `waitingOn` for a queued candidate, or `null`. */
// cm:guard report the EMPTY pool before a saturated one — "no runner is online" and "every runner is busy" read almost identically in the UI but need opposite actions (bring a host back vs. wait), and the empty-pool arm is the one that was missing while 11 jobs sat behind dead runners for up to 22 days
function runnerWaitingOn(
  candidate: PipelineHealthJob,
  sinceIso: string,
  runnerInFlight: ReadonlyMap<string, PipelineHealthRunnerSat>,
  runnerPool: RunnerAvailability,
): PipelineHealth['waitingOn'] {
  if (runnerPool.total === 0) {
    return { reason: 'runner_stale', since: sinceIso, details: { freshRunners: 0 } };
  }

  const sat = candidate.runnerId ? runnerInFlight.get(candidate.runnerId) : undefined;
  if (
    candidate.runnerId &&
    sat &&
    sat.inFlight >= sat.cap &&
    runnerSupportsJobType(
      sat.type as Parameters<typeof runnerSupportsJobType>[0],
      candidate.type as Parameters<typeof runnerSupportsJobType>[1],
    )
  ) {
    return {
      reason: 'runner_full',
      since: sinceIso,
      details: { runnerId: candidate.runnerId, cap: sat.cap, inFlight: sat.inFlight },
    };
  }

  // cm:why the pinned-runner branch above only covers a candidate that ALREADY has a runner_id; an unpinned job whose whole pool is busy fails the picker's pool-coarse EXISTS with nothing said about it here
  if (runnerPool.withCapacity === 0) {
    return {
      reason: 'runner_full',
      since: sinceIso,
      details: { freshRunners: runnerPool.total, runnersWithCapacity: 0 },
    };
  }

  return undefined;
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

  const blockingSession = sessions.find(
    (s) => (s.status === 'running' || s.status === 'queued') && s.id !== candidate.agentSessionId,
  );
  const blockingJob = activeJobs.find((j) => j.id !== candidate.id);
  if (blockingSession || blockingJob) {
    out.waitingOn = {
      reason: 'issue_busy',
      since: sinceIso,
      details: blockingSession
        ? { blockingSessionId: blockingSession.id }
        : {
            blockingJobId: blockingJob!.id,
            blockingJobType: blockingJob!.type,
          },
    };
    return out;
  }

  // cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts#blockedBy — must mirror that gate's
  //   satisfaction rule EXACTLY, or the gate holds an issue while this reports no waitingOn reason
  // cm:why a status check (`released|closed` = satisfied) drifted from the ISS-639 gate fix and starved
  //   a dependent 40min with a blank blocker banner — hence merged_at, with closed only when unstampable
  const depSatisfied = (status: string, mergedAt: Date | null): boolean =>
    mergedAt !== null || (!baseStampable && status === 'closed');

  const blockers = deps.filter(
    (d) => d.kind === 'blocks' && !depSatisfied(d.fromStatus, d.fromMergedAt),
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
    const pendingChildren = decompChildren.filter((c) => !depSatisfied(c.status, c.mergedAt));
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
