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
import { Sentry, isSentryEnabled } from '../observability/sentry.js';
import { boss } from '../queue/boss.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { reEnqueueForIssue } from './orchestrator.js';
import { type RecoveryConfig, decideRecovery } from './recovery-policy.js';
import { resolveSkillForStatus } from './skill-mapping.js';

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
  zeroWork: number;
}

// ISS-105 — silent skill-not-found surfacing.
//
// A pipeline session that finishes `status=completed` but produced ZERO
// assistant tool calls in under 10s is almost always Claude CLI treating an
// unknown `/forge-X` slash command as plain prompt text (the SKILL.md was
// missing or empty). Catch that signature and flip the session to
// `failed`/`skill_zero_work` so the stuck-issue scan + recovery-policy can
// escalate it instead of leaving the issue silently parked at the gate.
const ZERO_WORK_DURATION_MS = 10_000;
const ZERO_WORK_MAX_MESSAGES = 4;
const ZERO_WORK_LOOKBACK_MS = 5 * 60_000;

const KNOWN_PIPELINE_SKILLS: ReadonlySet<string> = new Set([
  'forge-triage',
  'forge-clarify',
  'forge-plan',
  'forge-code',
  'forge-review',
  'forge-fix',
  'forge-test',
  'forge-release',
]);

// Allowlist: skills whose legitimate runs may complete sub-10s with zero
// tool calls. `forge-staging` is the canonical no-op for jarvis-agents
// (see CLAUDE.md / forge-staging skill description, deprecated 2026-05-12).
const ZERO_WORK_ALLOWLIST: ReadonlySet<string> = new Set(['forge-staging']);

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
  // ISS-105 — the latest agent_session for this issue may carry a
  // skill-loader failure (`skill_zero_work` / `skill_not_found`) even when
  // the job row itself finished `done`. Surfacing it here lets
  // processStuckIssues coerce the recovery decision to escalate rather
  // than silently SKIP a job-`done` row whose session was zero-work.
  latestSessionFailureReason: string | null;
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

  // Pass 3 (ISS-105): zero-work — pipeline session finished `completed` but
  // produced no assistant tool calls in <10s. Signature of Claude CLI
  // treating a missing slash command as plain prompt text.
  const zeroWorkCutoff = new Date(now.getTime() - ZERO_WORK_LOOKBACK_MS);
  const skillNameList = sql.join(
    [...KNOWN_PIPELINE_SKILLS]
      .filter((n) => !ZERO_WORK_ALLOWLIST.has(n))
      .map((n) => sql`${n}`),
    sql`, `,
  );
  const dispatchedAtOrFallback = sql`COALESCE(${agentSessions.dispatchedAt}, ${agentSessions.startedAt}, ${agentSessions.createdAt})`;
  const zeroWorkFailed = await db
    .update(agentSessions)
    .set({ status: 'failed', failureReason: 'skill_zero_work', updatedAt: now })
    .where(
      and(
        eq(agentSessions.status, 'completed'),
        sql`${agentSessions.metadata}->>'type' = 'pipeline'`,
        sql`${agentSessions.metadata}->>'skillName' IN (${skillNameList})`,
        lt(dispatchedAtOrFallback, now),
        sql`${agentSessions.updatedAt} > ${zeroWorkCutoff}`,
        sql`EXTRACT(EPOCH FROM (${agentSessions.updatedAt} - ${dispatchedAtOrFallback})) * 1000 < ${ZERO_WORK_DURATION_MS}`,
        sql`COALESCE(jsonb_array_length(${agentSessions.messages}), 0) <= ${ZERO_WORK_MAX_MESSAGES}`,
        // Zero tool calls: no message has a non-empty `toolCalls` array AND
        // no message of type='assistant' carries any nested tool_use blocks.
        // The strict check on `toolCalls` mirrors `session-tracker.ts` which
        // is where the runner-side message shape comes from.
        sql`NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${agentSessions.messages}) AS m
          WHERE jsonb_typeof(m->'toolCalls') = 'array'
            AND jsonb_array_length(m->'toolCalls') > 0
        )`,
        ...(projectFilter ? [projectFilter] : []),
      ),
    )
    .returning({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
      metadata: agentSessions.metadata,
    });

  for (const z of zeroWorkFailed) {
    broadcastZombieTransition(z.id, z.projectId, z.deviceId, 'skill_zero_work');
    const meta = (z.metadata ?? {}) as { skillName?: string; jobType?: string; issueId?: string };
    if (isSentryEnabled()) {
      Sentry.addBreadcrumb({
        category: 'pipeline',
        level: 'error',
        message: 'skill_zero_work',
        data: {
          sessionId: z.id,
          projectId: z.projectId,
          issueId: meta.issueId,
          skillName: meta.skillName,
          jobType: meta.jobType,
          detection: 'post_flight',
        },
      });
      Sentry.captureMessage('pipeline.skill_zero_work', {
        level: 'error',
        tags: {
          skillName: meta.skillName ?? 'unknown',
          jobType: meta.jobType ?? 'unknown',
          detection: 'post_flight',
        },
      });
    }
    try {
      roomManager.publish(projectRoom(z.projectId), {
        event: 'pipeline.skill_zero_work',
        data: {
          sessionId: z.id,
          issueId: meta.issueId ?? null,
          skillName: meta.skillName ?? null,
          jobType: meta.jobType ?? null,
        },
      });
    } catch (err) {
      logger.warn({ err, sessionId: z.id }, 'pipeline-sweeper: zero-work WS broadcast failed');
    }
  }

  const queueTimedOut = queuedFailed.length;
  const heartbeatTimedOut = heartbeatFailed.length;
  const zeroWork = zeroWorkFailed.length;

  if (queueTimedOut > 0 || heartbeatTimedOut > 0 || zeroWork > 0) {
    logger.info(
      { queueTimedOut, heartbeatTimedOut, zeroWork, queueMs, heartbeatMs },
      'pipeline-sweeper: zombie sessions failed',
    );
  }

  return { queueTimedOut, heartbeatTimedOut, zeroWork };
}

function broadcastZombieTransition(
  sessionId: string,
  projectId: string,
  deviceId: string | null,
  reason: 'queue_timeout' | 'heartbeat_timeout' | 'skill_zero_work',
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
      // ISS-105 — a skill-loader signal at the session level wins over the
      // job's null failureKind. Without this coercion the sweeper SKIPs
      // (job ended `done`, kind=null) and the issue stays stuck silently.
      const skillFailureKind =
        row.latestSessionFailureReason === 'skill_zero_work' ||
        row.latestSessionFailureReason === 'skill_not_found'
          ? ('permanent' as const)
          : null;

      const failureKindForDecision: 'transient' | 'permanent' | 'unknown' | null =
        skillFailureKind ??
        (row.latestJobFailureKind === 'transient' ||
        row.latestJobFailureKind === 'permanent' ||
        row.latestJobFailureKind === 'unknown'
          ? row.latestJobFailureKind
          : null);

      const decision = decideRecovery({
        issue: {
          recoveryAttempts: row.recoveryAttempts,
          lastRecoveryAt: row.lastRecoveryAt,
          recoveryWindowStartedAt: row.recoveryWindowStartedAt,
        },
        failureKind: failureKindForDecision,
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
    const skill = resolveSkillForStatus(c.status);
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

    // ISS-105 — also surface the latest agent_session's failureReason so
    // processStuckIssues can spot `skill_zero_work` / `skill_not_found`
    // even when the job row finished `done`.
    const [latestSession] = await db
      .select({ failureReason: agentSessions.failureReason })
      .from(agentSessions)
      .where(sql`${agentSessions.metadata}->>'issueId' = ${c.id}::text`)
      .orderBy(desc(agentSessions.updatedAt))
      .limit(1);

    enriched.push({
      ...c,
      latestJobId: latest?.id ?? null,
      latestJobStatus: latest?.status ?? null,
      latestJobFailureKind: latest?.failureKind ?? null,
      latestJobFailureReason: latest?.failureReason ?? null,
      latestSessionFailureReason: latestSession?.failureReason ?? null,
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
