/**
 * ISS-164 (D4 of ISS-141) — pipelineHealth derived field + WS broadcast.
 *
 * Single server-side source of truth for per-issue gate state. Loader runs a
 * live join over `issues + jobs + agent_sessions + issue_dependencies` and
 * mirrors the Layer-1..L4 predicates in `jobs/dispatch-gates.ts`. No
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

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  agentSessions,
  issueDependencies,
  type IssueStatus,
  issues,
  jobs,
  runners,
} from '../db/schema.js';
import { resolveProjectCap, runnerSupportsJobType } from '../jobs/dispatch-gates.js';
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

export type PipelineWaitingReason =
  | 'issue_busy'
  | 'waiting_on_dep'
  | 'waiting_on_decomp_parent'
  | 'project_full'
  | 'runner_full';

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
}

export interface PipelineHealthDep {
  fromIssueId: string;
  kind: string;
  fromStatus: string;
}

export interface PipelineHealthRunnerSat {
  type: string;
  cap: number;
  inFlight: number;
}

export interface ClassifyInput {
  issue: { id: string; status: string };
  sessions: PipelineHealthSession[];
  jobs: PipelineHealthJob[];
  deps: PipelineHealthDep[];
  runningIssueIds: ReadonlySet<string>;
  runningIssueCount: number;
  cap: number;
  runnerInFlight: ReadonlyMap<string, PipelineHealthRunnerSat>;
  lastTickAt: Date | null;
}

/**
 * Pure classifier — given pre-fetched rows for a single issue, decide its
 * `PipelineHealth`. Kept separate from the SQL loader so unit tests can
 * exercise each L1..L4 branch without mocking drizzle. The loader composes
 * this for every requested issue id.
 */
export function classifyPipelineHealthForIssue(input: ClassifyInput): PipelineHealth {
  const { issue, sessions, jobs: issueJobs, deps, runningIssueIds, runningIssueCount, cap, runnerInFlight, lastTickAt } = input;

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

  if (queuedJobs.length === 0) return out;

  const candidate = [...queuedJobs].sort(
    (a, b) => a.queuedAt.getTime() - b.queuedAt.getTime(),
  )[0];
  if (!candidate) return out;
  const sinceIso = candidate.queuedAt.toISOString();
  out.queuedAt = sinceIso;

  const blockingSession = sessions.find(
    (s) =>
      (s.status === 'running' || s.status === 'queued') &&
      s.id !== candidate.agentSessionId,
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

  const blockers = deps.filter(
    (d) => d.kind === 'blocks' && !TERMINAL_STATUSES.has(d.fromStatus),
  );
  if (blockers.length > 0) {
    out.waitingOn = {
      reason: 'waiting_on_dep',
      since: sinceIso,
      details: { blockerIssueIds: blockers.map((b) => b.fromIssueId) },
    };
    return out;
  }

  if (candidate.type === 'release') {
    const decompParent = deps.find(
      (d) => d.kind === 'decomposes' && !TERMINAL_STATUSES.has(d.fromStatus),
    );
    if (decompParent) {
      out.waitingOn = {
        reason: 'waiting_on_decomp_parent',
        since: sinceIso,
        details: { parentIssueId: decompParent.fromIssueId },
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

  if (candidate.runnerId) {
    const sat = runnerInFlight.get(candidate.runnerId);
    if (
      sat &&
      sat.inFlight >= sat.cap &&
      runnerSupportsJobType(
        sat.type as Parameters<typeof runnerSupportsJobType>[0],
        candidate.type as Parameters<typeof runnerSupportsJobType>[1],
      )
    ) {
      out.waitingOn = {
        reason: 'runner_full',
        since: sinceIso,
        details: { runnerId: candidate.runnerId, cap: sat.cap, inFlight: sat.inFlight },
      };
      return out;
    }
  }

  return out;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['released', 'closed']);

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

  // Q3 — live jobs (queued/dispatched/running) for these issues.
  const jobRows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      queuedAt: jobs.queuedAt,
      runnerId: jobs.runnerId,
      agentSessionId: jobs.agentSessionId,
      issueId: jobs.issueId,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.projectId, projectId),
        inArray(jobs.issueId, ids),
        inArray(jobs.status, ['queued', 'dispatched', 'running']),
      ),
    );
  const jobsByIssue = new Map<string, PipelineHealthJob[]>();
  for (const r of jobRows) {
    if (!r.issueId) continue;
    const bucket = jobsByIssue.get(r.issueId) ?? [];
    bucket.push({
      id: r.id,
      type: r.type,
      status: r.status,
      queuedAt: r.queuedAt,
      runnerId: r.runnerId,
      agentSessionId: r.agentSessionId,
    });
    jobsByIssue.set(r.issueId, bucket);
  }

  // Q4 — dep edges pointing AT these issues (blocks / decomposes).
  const depRows = await db
    .select({
      toIssueId: issueDependencies.toIssueId,
      fromIssueId: issueDependencies.fromIssueId,
      kind: issueDependencies.kind,
      fromStatus: issues.status,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.fromIssueId))
    .where(
      and(
        inArray(issueDependencies.toIssueId, ids),
        inArray(issueDependencies.kind, ['blocks', 'decomposes']),
        sql`(${issueDependencies.validUntil} IS NULL OR ${issueDependencies.validUntil} > now())`,
      ),
    );
  const depsByIssue = new Map<string, PipelineHealthDep[]>();
  for (const r of depRows) {
    const bucket = depsByIssue.get(r.toIssueId) ?? [];
    bucket.push({ fromIssueId: r.fromIssueId, kind: r.kind, fromStatus: r.fromStatus });
    depsByIssue.set(r.toIssueId, bucket);
  }

  // Q5 — project_full inputs. The per-project cap defaults to 1 but is
  // operator-tunable via `pipelineConfig.maxConcurrentIssues`; resolve the
  // same value the dispatch picker enforces so this health card never drifts
  // from actual dispatch behaviour.
  const cap = await resolveProjectCap(projectId);
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

  // Q6 — runner saturation, only for queued candidates with a pinned runner.
  const candidateRunnerIds = new Set<string>();
  for (const list of jobsByIssue.values()) {
    for (const j of list) {
      if (j.status === 'queued' && j.runnerId) candidateRunnerIds.add(j.runnerId);
    }
  }
  const runnerInFlight = new Map<string, { type: string; cap: number; inFlight: number }>();
  if (candidateRunnerIds.size > 0) {
    const runnerRows = await db
      .select({
        id: runners.id,
        type: runners.type,
        capabilities: runners.capabilities,
      })
      .from(runners)
      .where(inArray(runners.id, [...candidateRunnerIds]));
    const inFlightRows = await db
      .select({ runnerId: jobs.runnerId, count: sql<string>`COUNT(*)::text` })
      .from(jobs)
      .where(
        and(
          inArray(jobs.runnerId, [...candidateRunnerIds]),
          inArray(jobs.status, ['dispatched', 'running']),
        ),
      )
      .groupBy(jobs.runnerId);
    const inFlightByRunner = new Map<string, number>();
    for (const r of inFlightRows) {
      if (r.runnerId) inFlightByRunner.set(r.runnerId, Number(r.count));
    }
    for (const r of runnerRows) {
      const caps = (r.capabilities ?? {}) as Record<string, unknown>;
      const runnerCap =
        typeof caps.maxConcurrent === 'number' && caps.maxConcurrent > 0
          ? caps.maxConcurrent
          : runnerDefaultConcurrency(r.type);
      runnerInFlight.set(r.id, {
        type: r.type,
        cap: runnerCap,
        inFlight: inFlightByRunner.get(r.id) ?? 0,
      });
    }
  }

  const lastTickAt = getLastTickAt(projectId);

  for (const issueId of ids) {
    const issueRow = issuesById.get(issueId);
    if (!issueRow) continue;
    const health = classifyPipelineHealthForIssue({
      issue: {
        id: issueRow.id,
        status: issueRow.status,
      },
      sessions: sessionsByIssue.get(issueId) ?? [],
      jobs: jobsByIssue.get(issueId) ?? [],
      deps: depsByIssue.get(issueId) ?? [],
      runningIssueIds,
      runningIssueCount,
      cap,
      runnerInFlight,
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
    logger.warn(
      { err, projectId, issueCount: issueIds.length },
      'pipeline-health: publish failed',
    );
  }
}
