/**
 * Pipeline self-healing sweeper (Phase H, ISS-306).
 *
 * Cron tick: every 60s, scan issues stuck in a pipeline-active status with
 * no active job and a terminal latest job. For each stuck issue:
 *   • Look up the latest job's failureKind (set by the classifier when
 *     the job ended in `failed`, or `null` for done/cancelled).
 *   • Ask recovery-policy whether to recover, escalate, or skip.
 *   • RECOVER  → bump issue.recovery_attempts (or reset if window
 *                expired), then call orchestrator.reEnqueueForIssue to
 *                kick off a fresh job. Activity-log + WS broadcast.
 *   • ESCALATE → transition issue to `pipeline_failed`, post a comment
 *                naming the failure, activity-log + WS broadcast.
 *   • SKIP     → no-op (cancelled jobs / done jobs / no-failure-kind).
 *
 * Idempotent: a second tick that finds the same row in the same state
 * either takes the same action again (recovery: orchestrator's unique
 * index dedupes) or finds the issue already at `pipeline_failed` (no
 * longer matches the scan filter).
 */

import { and, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  agentSessions,
  comments,
  issues,
  jobs,
  projects,
} from '../db/schema.js';
import { broadcastSessionEvent } from '../jobs/agent-session-link.js';
import { logger } from '../logger.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { reEnqueueForIssue } from './orchestrator.js';
import { type RecoveryConfig, decideRecovery } from './recovery-policy.js';
import { resolveJobTypeForStatus } from './skill-mapping.js';

export const PIPELINE_SWEEPER_QUEUE = 'pipeline-sweeper';

// Zombie thresholds clamp at MIN_TIMEOUT_MS so a low env override can't
// slaughter healthy sessions (a 10s heartbeat threshold would).
const QUEUE_TIMEOUT_MS_DEFAULT = 5 * 60_000;
const HEARTBEAT_TIMEOUT_MS_DEFAULT = 3 * 60_000;
const MIN_TIMEOUT_MS = 30_000;

const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

function readTimeoutEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_TIMEOUT_MS ? n : fallback;
}

export function getZombieThresholds(): { queueMs: number; heartbeatMs: number } {
  return {
    queueMs: readTimeoutEnv('PIPELINE_QUEUE_TIMEOUT_MS', QUEUE_TIMEOUT_MS_DEFAULT),
    heartbeatMs: readTimeoutEnv('PIPELINE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS_DEFAULT),
  };
}

const ACTIVE_PIPELINE_STATUSES: readonly IssueStatus[] = [
  'open',
  'confirmed',
  'approved',
  'in_progress',
  'developed',
  'deploying',
  'testing',
  'tested',
  'pass',
  'staging',
  'reopen',
];

export interface SweepResult {
  scanned: number;
  recovered: number;
  escalated: number;
  skipped: number;
  durationMs: number;
  zombieSessions?: ZombieSweepResult;
}

export interface ZombieSweepResult {
  queueTimedOut: number;
  heartbeatTimedOut: number;
}

export interface StuckIssueRow {
  id: string;
  projectId: string;
  status: IssueStatus;
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
  recoveryWindowStartedAt: Date | null;
  agentConfig: unknown;
  ownerId: string;
  latestJobId: string | null;
  latestJobStatus: string | null;
  latestJobFailureKind: string | null;
  latestJobFailureReason: string | null;
}

export async function runPipelineSweep(now: Date = new Date()): Promise<SweepResult> {
  // Zombie session sweep runs first; flipping abandoned sessions to `failed`
  // unblocks the stuck-issue scan (NOT EXISTS predicate matches once the
  // session leaves queued/running) so recovery policy retries the work.
  const zombieSessions = await sweepZombieSessions(now);
  const stuck = await selectStuckIssues();
  const result = await processStuckIssues(stuck, now);
  return { ...result, zombieSessions };
}

interface SweepScope {
  projectId?: string;
}

/**
 * Fail pipeline sessions abandoned by their worker.
 *
 *  - `queue_timeout`: session sat at `queued` past QUEUE_TIMEOUT_MS — no
 *    worker ever claimed it.
 *  - `heartbeat_timeout`: worker claimed (status='running') but stopped
 *    pinging past HEARTBEAT_TIMEOUT_MS.
 *
 * Scoped to pipeline/pm sessions; interactive chat sessions are out of
 * scope (their idle behaviour is by design). Optional `projectId` scope
 * lets the manual /sweep-zombies endpoint contain blast radius to one
 * project rather than flushing the whole instance.
 */
export async function sweepZombieSessions(
  now: Date,
  scope: SweepScope = {},
): Promise<ZombieSweepResult> {
  const { queueMs, heartbeatMs } = getZombieThresholds();
  const queueCutoff = new Date(now.getTime() - queueMs);
  const heartbeatCutoff = new Date(now.getTime() - heartbeatMs);
  const projectFilter = scope.projectId ? eq(agentSessions.projectId, scope.projectId) : undefined;

  // Pass 1: queued past timeout. CAS via WHERE status='queued' so a worker
  // that claims concurrently isn't stomped. dispatchedAt falls back to
  // createdAt for rows that pre-date the migration.
  const queuedFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'queue_timeout', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'queued'),
        or(
          and(isNotNull(agentSessions.dispatchedAt), lt(agentSessions.dispatchedAt, queueCutoff)),
          and(
            sql`${agentSessions.dispatchedAt} IS NULL`,
            lt(agentSessions.createdAt, queueCutoff),
          ),
        ),
        sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    });

  for (const z of queuedFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'queue_timeout');
  }

  // Pass 2: running with stale heartbeat. Falls back through startedAt →
  // updatedAt → createdAt so a rolling deploy with workers still running
  // older code (no heartbeat columns set) doesn't over-sweep — `updatedAt`
  // bumps on every legacy worker write so a >3min-busy job stays alive.
  const heartbeatFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'heartbeat_timeout', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'running'),
        or(
          and(
            isNotNull(agentSessions.lastHeartbeatAt),
            lt(agentSessions.lastHeartbeatAt, heartbeatCutoff),
          ),
          and(
            sql`${agentSessions.lastHeartbeatAt} IS NULL`,
            isNotNull(agentSessions.startedAt),
            lt(agentSessions.startedAt, heartbeatCutoff),
            lt(agentSessions.updatedAt, heartbeatCutoff),
          ),
          and(
            sql`${agentSessions.lastHeartbeatAt} IS NULL`,
            sql`${agentSessions.startedAt} IS NULL`,
            lt(agentSessions.updatedAt, heartbeatCutoff),
            lt(agentSessions.createdAt, heartbeatCutoff),
          ),
        ),
        sql`${agentSessions.metadata}->>'type' IN ${PIPELINE_METADATA_TYPES}`,
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
    });

  for (const z of heartbeatFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'heartbeat_timeout');
  }

  const queueTimedOut = queuedFailed.length;
  const heartbeatTimedOut = heartbeatFailed.length;

  if (queueTimedOut > 0 || heartbeatTimedOut > 0) {
    logger.info(
      { queueTimedOut, heartbeatTimedOut, queueMs, heartbeatMs },
      'pipeline-sweeper: zombie sessions failed',
    );
  }

  return { queueTimedOut, heartbeatTimedOut };
}

function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'heartbeat_timeout',
): void {
  broadcastSessionEvent(sessionId, projectId, deviceId, 'agent-session.status', {
    status: 'failed',
    failureReason: reason,
  });
}

/**
 * Pure decision + side-effect loop given a pre-fetched set of stuck rows.
 * Split out from runPipelineSweep so tests can hand-craft the input array
 * without mocking 5 distinct Drizzle chain shapes.
 */
export async function processStuckIssues(
  stuck: StuckIssueRow[],
  now: Date,
): Promise<SweepResult> {
  const t0 = Date.now();
  let recovered = 0;
  let escalated = 0;
  let skipped = 0;

  for (const row of stuck) {
    try {
      const decision = decideRecovery({
        issue: {
          recoveryAttempts: row.recoveryAttempts,
          lastRecoveryAt: row.lastRecoveryAt,
          recoveryWindowStartedAt: row.recoveryWindowStartedAt,
        },
        failureKind:
          row.latestJobFailureKind === 'transient' ||
          row.latestJobFailureKind === 'permanent' ||
          row.latestJobFailureKind === 'unknown'
            ? row.latestJobFailureKind
            : null,
        config: extractRecoveryConfig(row.agentConfig),
        now,
      });

      if (decision.decide === 'recover') {
        await applyRecover(row, decision.nextAttempt, decision.resetWindow, now);
        recovered++;
      } else if (decision.decide === 'escalate') {
        await applyEscalate(row, decision.reason);
        escalated++;
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error(
        { err, issueId: row.id },
        'pipeline-sweeper: per-issue handler threw, continuing',
      );
      skipped++;
    }
  }

  if (stuck.length > 0 || recovered + escalated > 0) {
    logger.info(
      { scanned: stuck.length, recovered, escalated, skipped },
      'pipeline-sweeper: tick complete',
    );
  }

  return {
    scanned: stuck.length,
    recovered,
    escalated,
    skipped,
    durationMs: Date.now() - t0,
  };
}

async function selectStuckIssues(): Promise<StuckIssueRow[]> {
  const candidates = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      recoveryAttempts: issues.recoveryAttempts,
      lastRecoveryAt: issues.lastRecoveryAt,
      recoveryWindowStartedAt: issues.recoveryWindowStartedAt,
      agentConfig: projects.agentConfig,
      ownerId: projects.ownerId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        inArray(issues.status, [...ACTIVE_PIPELINE_STATUSES]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${jobs} j
          WHERE j.issue_id = ${issues.id}
            AND j.status IN ('queued', 'dispatched', 'running')
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${agentSessions} a
          WHERE a.metadata->>'issueId' = ${issues.id}::text
            AND a.status IN ('queued', 'running')
        )`,
      ),
    );

  if (candidates.length === 0) return [];

  const enriched: StuckIssueRow[] = [];
  for (const c of candidates) {
    const skill = resolveJobTypeForStatus(c.status);
    const baseQuery = db
      .select({
        id: jobs.id,
        status: jobs.status,
        failureKind: jobs.failureKind,
        failureReason: jobs.failureReason,
      })
      .from(jobs);
    const latestQuery = skill
      ? baseQuery
          .where(and(eq(jobs.issueId, c.id), eq(jobs.type, skill.type)))
          .orderBy(desc(jobs.createdAt))
          .limit(1)
      : baseQuery.where(eq(jobs.issueId, c.id)).orderBy(desc(jobs.createdAt)).limit(1);

    const [latest] = await latestQuery;
    enriched.push({
      ...c,
      latestJobId: latest?.id ?? null,
      latestJobStatus: latest?.status ?? null,
      latestJobFailureKind: latest?.failureKind ?? null,
      latestJobFailureReason: latest?.failureReason ?? null,
    });
  }
  return enriched;
}

async function applyRecover(
  row: StuckIssueRow,
  nextAttempt: number,
  resetWindow: boolean,
  now: Date,
): Promise<void> {
  await db
    .update(issues)
    .set({
      recoveryAttempts: nextAttempt,
      lastRecoveryAt: now,
      recoveryWindowStartedAt: resetWindow ? now : (row.recoveryWindowStartedAt ?? now),
      updatedAt: now,
    })
    .where(eq(issues.id, row.id));

  await reEnqueueForIssue({
    projectId: row.projectId,
    issueId: row.id,
    status: row.status,
    // ActorType only allows 'user'|'device'; sweeper-driven recovery
    // attributes the trigger to the project owner so jobs.created_by
    // stays a valid users.id FK. The `reason.sweeper.*` payload below
    // is the audit signal that this was actually system-driven.
    actor: { type: 'user', id: row.ownerId },
    reason: {
      sweeper: {
        kind: 'recover',
        attempt: nextAttempt,
        prevJobId: row.latestJobId,
        prevFailureKind: row.latestJobFailureKind,
      },
    },
  });

  roomManager.publish(projectRoom(row.projectId), {
    event: 'pipeline.recovered',
    data: {
      issueId: row.id,
      attempt: nextAttempt,
      prevFailureKind: row.latestJobFailureKind,
    },
  });

  logger.info(
    { issueId: row.id, attempt: nextAttempt, prevFailureKind: row.latestJobFailureKind },
    'pipeline-sweeper: recover',
  );
}

async function applyEscalate(row: StuckIssueRow, reason: string): Promise<void> {
  const note = buildEscalationComment(row, reason);
  await db
    .update(issues)
    .set({ status: 'pipeline_failed', updatedAt: new Date() })
    .where(eq(issues.id, row.id));

  try {
    await db.insert(comments).values({
      issueId: row.id,
      authorId: row.ownerId,
      body: note,
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn({ err, issueId: row.id }, 'pipeline-sweeper: escalation comment insert failed');
  }

  roomManager.publish(projectRoom(row.projectId), {
    event: 'pipeline.escalated',
    data: {
      issueId: row.id,
      from: row.status,
      to: 'pipeline_failed',
      reason,
    },
  });

  logger.warn(
    { issueId: row.id, fromStatus: row.status, reason },
    'pipeline-sweeper: escalated to pipeline_failed',
  );
}

function buildEscalationComment(row: StuckIssueRow, reason: string): string {
  const failure = row.latestJobFailureReason ?? '(no failure reason recorded)';
  const kind = row.latestJobFailureKind ?? 'unknown';
  return [
    `🛑 **Pipeline gave up** — issue moved to \`pipeline_failed\`.`,
    ``,
    `**Reason:** ${reason}`,
    `**Last failure (${kind}):** ${failure}`,
    ``,
    `Re-triage by setting status back to \`confirmed\` once the underlying issue is fixed (or the policy block is lifted upstream).`,
  ].join('\n');
}

function extractRecoveryConfig(agentConfig: unknown): Partial<RecoveryConfig> | null {
  if (!agentConfig || typeof agentConfig !== 'object') return null;
  const pc = (agentConfig as { pipelineConfig?: unknown }).pipelineConfig;
  if (!pc || typeof pc !== 'object') return null;
  const cfg = pc as {
    recoveryMaxAttempts?: number;
    recoveryWindowHours?: number;
    recoveryByFailureKind?: Partial<Record<'transient' | 'permanent' | 'unknown', number>>;
  };
  return {
    ...(cfg.recoveryMaxAttempts !== undefined ? { maxAttempts: cfg.recoveryMaxAttempts } : {}),
    ...(cfg.recoveryWindowHours !== undefined ? { windowHours: cfg.recoveryWindowHours } : {}),
    ...(cfg.recoveryByFailureKind ? { byKind: cfg.recoveryByFailureKind } : {}),
  };
}

let registered = false;

export async function registerPipelineSweeper(): Promise<void> {
  if (registered) return;
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).createQueue(PIPELINE_SWEEPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).work(PIPELINE_SWEEPER_QUEUE, async () => {
    try {
      const result = await runPipelineSweep();
      if (result.recovered > 0 || result.escalated > 0) {
        logger.info(result, 'pipeline-sweeper: actioned');
      }
    } catch (err) {
      logger.error({ err }, 'pipeline-sweeper: tick failed');
      throw err;
    }
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss v10 type drift
  await (boss as any).schedule(PIPELINE_SWEEPER_QUEUE, '* * * * *'); // every minute
  registered = true;
}

export function resetPipelineSweeperForTest(): void {
  registered = false;
}
