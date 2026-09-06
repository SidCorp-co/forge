/**
 * ISS-164 (D4 of ISS-141) — pipelineHealth derived field + WS broadcast.
 *
 * Single server-side source of truth for per-issue gate state. Loader runs a
 * live join over `issues + jobs + pipeline_runs + agent_sessions +
 * issue_dependencies`, plus the picker's own `fresh_capable_runners` CTE
 * (`freshRunnerAvailability`), and mirrors EVERY arm of the dispatch CASE in
 * `jobs/queued-gates.ts`. A gate with no arm here renders as an idle,
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
import { agentSessions, type IssueStatus, issues } from '../db/schema.js';
import { freshRunnerAvailability } from '../jobs/queued-gates.js';
import { logger } from '../logger.js';
import { projectRoom } from '../ws/rooms.js';
import { loadActiveJobsByIssue, loadPausedRunsByIssue } from './pipeline-health-loaders.js';
import {
  heldWaitingOn,
  queuedStepOf,
  retryCooldownWaitingOn,
  runnerWaitingOn,
} from './pipeline-health-reasons.js';
import type {
  ClassifyInput,
  PipelineHealth,
  PipelineHealthSession,
} from './pipeline-health-types.js';

// cm:edge contract -> packages/core/src/issues/pipeline-health-types.ts — every consumer imports these names from THIS path, so the re-export is the public surface; dropping it moves the break to eleven call sites rather than one
export type {
  ClassifyInput,
  PipelineHealth,
  PipelineHealthJob,
  PipelineHealthPausedRun,
  PipelineHealthQueuedStep,
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
 * Pure classifier — given pre-fetched rows for a single issue, decide its
 * `PipelineHealth`. Kept separate from the SQL loader so unit tests can
 * exercise each L1..L4 branch without mocking drizzle. The loader composes
 * this for every requested issue id.
 */
export function classifyPipelineHealthForIssue(input: ClassifyInput): PipelineHealth {
  const { issue, sessions, jobs: issueJobs, runnerPool, lastTickAt } = input;

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

  // cm:guard ISS-853 — above every `return out` below, and gated on NOTHING: a paused run stops the issue whatever its own status says and whether or not a step is queued, and the `run_not_running` arm further down reaches it only through a queued candidate, so an issue with none rendered no banner at all
  if (input.pausedRun) out.pausedRun = input.pausedRun;

  // cm:guard the candidate is picked HERE, above the held arm, so `queuedAt` and `queuedStep` describe the queued step whichever arm goes on to own `waitingOn` — an issue carrying a held job AND a queued one still has a step nobody can see, which is the ISS-903 blind spot. The `waitingOn` PRECEDENCE below is unchanged; only the projection moved.
  const candidate = [...queuedJobs].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())[0];
  if (candidate) {
    out.queuedAt = candidate.queuedAt.toISOString();
    out.queuedStep = queuedStepOf(candidate);
  }

  // cm:guard this call MUST stay above the `queuedJobs.length === 0` return — a held job is usually the issue's ONLY job, so deriving it from inside the queued-candidate block below reports nothing at all in exactly the case that matters
  const held = heldWaitingOn(issueJobs);
  if (held) {
    out.waitingOn = held;
    return out;
  }

  if (!candidate) return out;
  const sinceIso = candidate.queuedAt.toISOString();

  // cm:guard this arm belongs FIRST among the queued reasons, matching the CASE in dispatch-gates.ts — a paused or terminal parent run makes every later gate moot, and reporting `project_full` for it sends the reader after a slot that would change nothing
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

  const runnerWait = runnerWaitingOn(sinceIso, runnerPool);
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
  // cm:why Q4 reads `pipeline_runs` by issue id rather than joining through Q3 — Q3 has no row at all for an issue whose run is paused with nothing queued, which is the only shape ISS-853 is about
  const pausedRunsByIssue = await loadPausedRunsByIssue(projectId, ids);

  const runnerPool = await freshRunnerAvailability(projectId);
  const lastTickAt = getLastTickAt(projectId);

  for (const issueId of ids) {
    const issueRow = issuesById.get(issueId);
    if (!issueRow) continue;
    const pausedRun = pausedRunsByIssue.get(issueId);
    const health = classifyPipelineHealthForIssue({
      issue: {
        id: issueRow.id,
        status: issueRow.status,
        mergedAt: issueRow.mergedAt,
        waitingKind: issueRow.waitingKind,
      },
      sessions: sessionsByIssue.get(issueId) ?? [],
      jobs: jobsByIssue.get(issueId) ?? [],
      runnerPool,
      lastTickAt,
      ...(pausedRun ? { pausedRun } : {}),
    });
    map.set(issueId, health);
  }

  return map;
}

// cm:guard this is the ONE degrade-to-stage-only wrapper — `issues/routes.ts` and `issues/search.ts` both call it rather than keeping a copy each. pipelineHealth is derived, so a transient DB blip (or a partial drizzle mock in a unit test) must not 500 a list of issues; callers graft `{ stage: row.status }` for any id the map omits.
export async function safeHydratePipelineHealthForIssues(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, PipelineHealth>> {
  try {
    return await hydratePipelineHealthForIssues(projectId, issueIds);
  } catch (err) {
    logger.warn(
      { err, projectId, issueCount: issueIds.length },
      'pipeline-health: hydrate failed; falling back to stage-only',
    );
    return new Map();
  }
}

export async function publishPipelineHealthChanged(
  projectId: string,
  issueIds: readonly string[],
): Promise<void> {
  if (issueIds.length === 0) return;
  try {
    // cm:guard keep this import lazy — a top-level one pulls the websocket + runner-heartbeat graph, and so pg-boss and DATABASE_URL, into every unit test that imports the loader half of this module for the REST routes alone
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
