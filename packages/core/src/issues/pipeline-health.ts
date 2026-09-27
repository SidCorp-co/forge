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
 * ISS-1273 — the session bind is TWO binds, not one. `metadata->>'issueId'` is the job lane's
 * link and reaches nothing else; a run session opened by `devices/run-session.ts` carries a GROUP
 * of issues and links to each through its `issue_leases` row. Beside both, `issues.session_context
 * .lease` is the only record a driver lane leaves, and `worker` is where all three are answered —
 * including the arm that says no lane can.
 *
 * WS event `issue.pipelineHealth.changed` is published directly (NOT routed
 * through `pipeline/hooks.ts` -> `ws/broadcast-subscribers.ts`) because the
 * payload is a derived snapshot recomputed at publish time — the same pattern
 * `issue.statusChanged` uses. Keep it direct.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus, WaitingKind } from '../db/schema.js';
import { freshRunnerAvailability } from '../jobs/queued-gates.js';
import { logger } from '../logger.js';
import { holderFanout, readClaim } from '../pipeline/lease-fanout.js';
import type { LeaseReading } from '../pipeline/session-claim.js';
import { projectRoom } from '../ws/rooms.js';
import { classifyIssueWorker, type SessionWorkerLane, unreadableWorker } from './issue-worker.js';
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

export type { IssueWorker, SessionWorkerLane, WorkerSession } from './issue-worker.js';

/** ISS-1273 — the answer a caller serves for an issue the loader gave it nothing for. */
export function pipelineHealthUnderived(stage: IssueStatus): PipelineHealth {
  return {
    stage,
    worker: unreadableWorker(
      'core could not derive this issue health; the stage is its stored status and nothing here was read from a run, a session or a claim',
    ),
  };
}
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

  const out: PipelineHealth = {
    stage: issue.status as IssueStatus,
    worker: classifyIssueWorker({
      sessions: sessions.map((s) => ({ id: s.id, status: s.status, lane: s.lane })),
      claim: input.claim ?? null,
    }),
  };
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

/** `db.execute` rows — object literals, which its `T extends Record<string, unknown>` needs. */
type IssueRow = {
  id: string;
  status: string;
  project_id: string;
  merged_at: string | null;
  waiting_kind: WaitingKind | null;
  lease: unknown;
};

type SessionRow = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  issue_id: string | null;
  lane: SessionWorkerLane;
};

export async function hydratePipelineHealthForIssues(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, PipelineHealth>> {
  const map = new Map<string, PipelineHealth>();
  if (issueIds.length === 0) return map;
  const ids = [...issueIds];
  const idList = sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;

  const issueRows = (await db.execute(sql`
    SELECT i.id, i.status, i.project_id, i.merged_at, i.waiting_kind,
           i.session_context -> 'lease' AS lease
      FROM issues i
     WHERE i.id IN ${idList}
  `)) as unknown as IssueRow[];
  const issuesById = new Map(issueRows.map((r) => [r.id, r]));

  // Q2 — the two session binds. `lane` carries which one found each row.
  const sessionRows = (await db.execute(sql`
    SELECT s.id, s.status, s.metadata, i.id AS issue_id, 'job' AS lane, s.updated_at
      FROM agent_sessions s
      JOIN issues i ON i.id::text = s.metadata->>'issueId'
     WHERE s.project_id = ${projectId}
       AND s.status IN ('queued', 'running', 'completed', 'failed')
       AND i.id IN ${idList}
    UNION ALL
    SELECT s.id, s.status, s.metadata, i.id AS issue_id, 'run_session' AS lane, s.updated_at
      FROM issue_leases l
      JOIN agent_sessions s ON s.id = l.session_id
      JOIN issues i ON i.project_id = l.project_id
                   AND 'ISS-' || i.iss_seq = l.issue_key -- ISS-992:canonical
     WHERE s.project_id = ${projectId}
       AND s.status IN ('queued', 'running', 'completed', 'failed')
       AND i.id IN ${idList}
     ORDER BY updated_at DESC
  `)) as unknown as SessionRow[];
  const sessionsByIssue = new Map<string, PipelineHealthSession[]>();
  for (const r of sessionRows) {
    if (!r.issue_id) continue;
    const bucket = sessionsByIssue.get(r.issue_id) ?? [];
    bucket.push({
      id: r.id,
      status: r.status,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      lane: r.lane,
    });
    sessionsByIssue.set(r.issue_id, bucket);
  }

  // Q3 — the claim lane, read by the module that owns that blob.
  const now = new Date();
  const fanout = await holderFanout(
    issueRows.map((r) => r.lease),
    now,
  );
  const claimsByIssue = new Map<string, LeaseReading>(
    issueRows.map((r) => [r.id, readClaim(r.lease, now, fanout)]),
  );

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
        mergedAt: issueRow.merged_at === null ? null : new Date(issueRow.merged_at),
        waitingKind: issueRow.waiting_kind,
      },
      sessions: sessionsByIssue.get(issueId) ?? [],
      jobs: jobsByIssue.get(issueId) ?? [],
      runnerPool,
      claim: claimsByIssue.get(issueId) ?? null,
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
