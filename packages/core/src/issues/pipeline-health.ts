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
 * Pure classifier — given pre-fetched rows for a single issue, decide its
 * `PipelineHealth`. Kept separate from the SQL loader so unit tests can
 * exercise each L1..L4 branch without mocking drizzle. The loader composes
 * this for every requested issue id.
 */
export function classifyPipelineHealthForIssue(input: ClassifyInput): PipelineHealth {
  const { issue, sessions, jobs: issueJobs, runnerPool } = input;

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

  if (issue.status === 'waiting' && issue.waitingKind) {
    out.waitingCause = { kind: issue.waitingKind };
  }

  if (input.pausedRun) out.pausedRun = input.pausedRun;

  const candidate = [...queuedJobs].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())[0];
  if (candidate) {
    out.queuedAt = candidate.queuedAt.toISOString();
    out.queuedStep = queuedStepOf(candidate);
  }

  const held = heldWaitingOn(issueJobs);
  if (held) {
    out.waitingOn = held;
    return out;
  }

  if (!candidate) return out;
  const sinceIso = candidate.queuedAt.toISOString();

  if (candidate.pipelineRunStatus && candidate.pipelineRunStatus !== 'running') {
    out.waitingOn = {
      reason: 'run_not_running',
      since: sinceIso,
      details: { runStatus: candidate.pipelineRunStatus, queuedJobId: candidate.id },
    };
    return out;
  }

  const cooldown = retryCooldownWaitingOn(candidate, sinceIso, input.now ?? new Date());
  if (cooldown) {
    out.waitingOn = cooldown;
    return out;
  }

  const blockingSession = sessions.find(
    (s) => (s.status === 'running' || s.status === 'queued') && s.id !== candidate.agentSessionId,
  );
  const blockingJob = activeJobs.find((j) => j.id !== candidate.id);
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
  const pausedRunsByIssue = await loadPausedRunsByIssue(projectId, ids);

  const runnerPool = await freshRunnerAvailability(projectId);

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
      ...(pausedRun ? { pausedRun } : {}),
    });
    map.set(issueId, health);
  }

  return map;
}

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
