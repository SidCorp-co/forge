/**
 * A runner or a member writing one session: its columns, the worker-activity
 * rules, the skill and blind-run verdicts, then the write and its broadcasts.
 * The route owns access; this owns what the patch means.
 */

import { z } from 'zod';
import {
  type AgentSessionStatus,
  agentSessionStatuses,
  type agentSessions,
  sessionRuntimeStates,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import type { restActor } from '../middleware/auth.js';
import { logger } from '../observability/logger.js';
import { broadcastSession, broadcastTurnAppended, broadcastTurnTruncated } from './broadcast.js';
import { syncRunnerHealthFromChatTerminal } from './chat-runner-health.js';
import { applyTranscriptPatch } from './patch-transcript.js';
import { refuseSession } from './refusals.js';
import {
  BLIND_SCHEDULE_RUN_REASON,
  countTranscriptToolCalls,
  isBlindScheduleRun,
} from './schedule-evidence.js';
import { writeSessionPatch } from './service.js';
import { loadSessionOr404 } from './session-access.js';
import {
  type AgentSessionPatch,
  detectUnexpandedSkillFailure,
  finalizeScheduleSessionFailure,
} from './session-failure.js';

type SessionRow = typeof agentSessions.$inferSelect;
type Meta = Record<string, unknown>;

export const sessionPatchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    messages: z.array(z.unknown()).optional(),
    usage: z.unknown().optional(),
    metadata: z.unknown().optional(),
    diff: z.unknown().optional(),
    toolCallCount: z.number().int().min(0).optional(),
    turnError: z.string().max(4000).optional(),
    runtimeState: z.enum(sessionRuntimeStates).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

type SessionPatchBody = z.infer<typeof sessionPatchSchema>;

const TERMINAL_SESSION_STATUSES: ReadonlySet<AgentSessionStatus> = new Set(
  terminalAgentSessionStatuses,
);

function columnUpdates(
  patch: SessionPatchBody,
  isDevice: boolean,
  messages: unknown[] | undefined,
  now: Date,
): AgentSessionPatch {
  const updates: AgentSessionPatch = { updatedAt: now };
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.claudeSessionId !== undefined) updates.claudeSessionId = patch.claudeSessionId;
  if (patch.runtimeState !== undefined && isDevice) updates.runtimeState = patch.runtimeState;
  if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
  if (patch.usage !== undefined) updates.usage = patch.usage;
  if (patch.metadata !== undefined) updates.metadata = patch.metadata;
  if (patch.diff !== undefined) updates.diff = patch.diff;
  if (messages !== undefined) updates.messages = messages;
  return updates;
}

/** Heartbeat, queued→running and revival; returns whether the user cancelled it. */
function stampActivity(
  updates: AgentSessionPatch,
  patch: SessionPatchBody,
  existing: SessionRow,
  now: Date,
): boolean {
  const isWorkerActivity =
    (patch.runtimeState !== undefined && patch.runtimeState !== 'awaiting_input') ||
    patch.messages !== undefined ||
    patch.claudeSessionId !== undefined ||
    patch.usage !== undefined ||
    patch.status !== undefined ||
    patch.diff !== undefined;
  // A user_cancelled session must never silently revive — once cancelled,
  // a worker stream that arrives late should be dropped, not re-attached.
  const isUserCancelled =
    existing.status === 'failed' && existing.failureReason === 'user_cancelled';
  if (isUserCancelled && (patch.status === 'running' || patch.status === 'queued')) {
    throw refuseSession('SESSION_CANCELLED', 'session was cancelled by user');
  }
  if (isWorkerActivity && !isUserCancelled) updates.lastHeartbeatAt = now;
  if (patch.status === undefined && isWorkerActivity && existing.status === 'queued') {
    updates.status = 'running';
    updates.startedAt = now;
  } else if (patch.status === 'running' && existing.startedAt == null) {
    updates.startedAt = now;
  }
  if (
    (updates.status === 'running' || updates.status === 'queued') &&
    existing.failureReason &&
    existing.failureReason !== 'user_cancelled'
  ) {
    updates.failureReason = null;
    updates.failureDetail = null;
  }
  return isUserCancelled;
}

/** A turn that ran a skill settles it: failed when the skill never expanded, the pending keys dropped. */
function settlePendingSkill(
  updates: AgentSessionPatch,
  patch: SessionPatchBody,
  existing: SessionRow,
  messages: unknown[] | undefined,
): void {
  const meta = (existing.metadata as Meta | null) ?? null;
  const pendingSkillName =
    typeof meta?.pendingSkillName === 'string' ? meta.pendingSkillName : null;
  if (!pendingSkillName || (patch.status !== 'completed' && patch.status !== 'failed')) return;
  if (patch.status === 'completed') {
    // Prefer the pre-turn baseline stamped in chat-dispatch.ts (the message
    // count right after the user turn, before any assistant reply) over
    // `existing.messages.length` — an interim `running` PATCH may have
    // already persisted this turn's assistant messages before this
    // terminal PATCH lands, which would make a freshly-recomputed count
    // include them and slice them out of the scan.
    const priorCount =
      typeof meta?.pendingSkillBaselineCount === 'number'
        ? meta.pendingSkillBaselineCount
        : Array.isArray(existing.messages)
          ? existing.messages.length
          : 0;
    if (detectUnexpandedSkillFailure(messages ?? existing.messages, pendingSkillName, priorCount)) {
      updates.status = 'failed';
      updates.failureReason = 'skill_not_synced';
    }
  }
  const {
    pendingSkillName: _name,
    pendingSkillBaselineCount: _count,
    ...rest
  } = (updates.metadata as Meta | undefined) ?? meta ?? {};
  updates.metadata = rest;
}

/** The runner's tool-call count lands in metadata, and a scheduled run that called none is recorded blind. */
function stampToolCalls(
  updates: AgentSessionPatch,
  patch: SessionPatchBody,
  existing: SessionRow,
  derived: boolean,
  principal: string | undefined,
): void {
  const meta = (existing.metadata as Meta | null) ?? null;
  const toolCallCount = derived ? countTranscriptToolCalls(existing.messages) : patch.toolCallCount;
  if (toolCallCount !== undefined && principal === 'device') {
    updates.metadata = { ...((updates.metadata as Meta | undefined) ?? meta ?? {}), toolCallCount };
  }
  const blind = isBlindScheduleRun({
    resolvedStatus: (updates.status as AgentSessionStatus | undefined) ?? patch.status,
    metadata: (updates.metadata as Meta | undefined) ?? meta,
    toolCallCount,
    principal,
  });
  if (!blind) return;
  updates.status = 'failed';
  updates.failureReason = BLIND_SCHEDULE_RUN_REASON;
  logger.warn(
    { sessionId: existing.id, scheduleId: meta?.scheduleId },
    'agent-sessions: scheduled run reported completed having called no tool — recording it blind',
  );
}

function publishPatch(
  updated: SessionRow,
  sync: Awaited<ReturnType<typeof writeSessionPatch>>['sync'],
  statusChanged: boolean,
): void {
  if (sync) {
    // First new turn fires immediately so the client learns the turn id.
    // Subsequent appends (multi-block worker write) ride the tail-debouncer
    // in broadcastTurnAppended to keep WS load manageable while the runner
    // streams a long assistant reply.
    sync.appended.forEach((t, i) => {
      broadcastTurnAppended(updated, t, { isStreamingTail: i > 0 });
    });
    if (sync.truncatedFromTurnIndex !== null) {
      broadcastTurnTruncated(updated, sync.truncatedFromTurnIndex);
    }
  }
  broadcastSession(updated, statusChanged ? 'agent-session.status' : 'agent-session.updated');
}

export async function applySessionPatch(args: {
  existing: SessionRow;
  patch: SessionPatchBody;
  principal: string | undefined;
  userActor: ReturnType<typeof restActor>;
}): Promise<SessionRow> {
  const { patch, principal } = args;
  const id = args.existing.id;
  const isDevice = principal === 'device';
  const transcript = await applyTranscriptPatch({
    sessionId: id,
    isDevice,
    isTerminal: patch.status !== undefined && TERMINAL_SESSION_STATUSES.has(patch.status),
    patch,
  });
  const messages = transcript.messages;
  const existing = transcript.derived ? await loadSessionOr404(id) : args.existing;

  const now = new Date();
  const updates = columnUpdates(patch, isDevice, messages, now);
  const isUserCancelled = stampActivity(updates, patch, existing, now);
  settlePendingSkill(updates, patch, existing, messages);
  stampToolCalls(updates, patch, existing, transcript.derived, principal);

  const classification =
    patch.status === 'failed' && !isUserCancelled && existing.failureReason !== 'user_cancelled'
      ? await finalizeScheduleSessionFailure({
          sessionId: id,
          messages: messages ?? existing.messages,
          note: null,
          baseMetadata:
            (updates.metadata as Meta | undefined) ?? (existing.metadata as Meta | null) ?? {},
          set: updates,
        })
      : null;

  if (
    (updates.status ?? existing.status) === 'completed' &&
    existing.failureReason &&
    existing.failureReason !== 'user_cancelled'
  ) {
    updates.failureReason = null;
    updates.failureDetail = null;
  }

  // The messages array and agent_session_turns are written in one transaction
  // so the legacy blob and turn rows can never diverge.
  const { status: nextStatus, ...columns } = updates;
  const { updated, sync } = await writeSessionPatch({
    sessionId: id,
    existing,
    columns,
    to: nextStatus,
    actor: isDevice ? { type: 'runner', id: existing.deviceId } : args.userActor,
    snapshot: transcript.snapshot && messages ? messages : null,
    messages: patch.messages !== undefined ? (messages ?? []) : null,
    at: now,
  });
  publishPatch(updated, sync, patch.status !== undefined && patch.status !== existing.status);

  if (classification) {
    await classification.recoverAfterWrite(updated.metadata ?? existing.metadata);
  }
  await syncRunnerHealthFromChatTerminal({
    sessionId: id,
    projectId: updated.projectId,
    deviceId: updated.deviceId,
    principal,
    reportedStatus: patch.status,
    persistedStatus: updated.status,
    isUserCancelled,
    messages: messages ?? existing.messages,
  });
  return updated;
}
