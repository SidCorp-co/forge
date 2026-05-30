/**
 * ISS-283 — derive the canonical `agent_sessions` transcript for CLI-runner
 * jobs from the `job_events` core already stores.
 *
 * The `forge-runner` CLI streams every raw Claude stream-json line as a
 * `stdout` job_event (and `claudeSessionId` as a `progress` event) but, unlike
 * the desktop app, never PATCHes the linked `agent_sessions` row — it can't,
 * because that route is user-JWT-gated and the runner holds only a device
 * token. So the session-detail page is empty for CLI-run jobs.
 *
 * Instead of a new device write-path + a Rust parser port, we derive the
 * transcript server-side on the device-authed paths core already owns: the
 * events handler (throttled, incremental) and the lifecycle handlers (final,
 * authoritative). Every write here is best-effort — a parse/DB hiccup must
 * never block event ingest or job `/complete`.
 */
import { asc, eq } from 'drizzle-orm';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnTruncated,
} from '../agent-sessions/broadcast.js';
import { syncTurnsWithMessages } from '../agent-sessions/turns-helpers.js';
import { db } from '../db/client.js';
import { agentSessions, jobEvents } from '../db/schema.js';
import { buildSessionFromEvents } from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';

// Mirror the desktop SessionTracker thresholds (session-tracker.ts): flush at
// most every ~30s, or sooner once a burst of stream lines has accumulated.
const INCREMENTAL_FLUSH_INTERVAL_MS = 30_000;
const INCREMENTAL_FLUSH_STDOUT_THRESHOLD = 8;

interface FlushState {
  lastFlushAtMs: number;
  stdoutSinceFlush: number;
  /** In-flight derive promise, so a final flush can await a racing incremental
   *  one before writing the authoritative transcript (prevents a late partial
   *  write from clobbering the complete one). */
  inFlight: Promise<void> | null;
  /** Once the job is terminal, incremental flushes no-op — the final derive owns
   *  the last write. */
  finalized: boolean;
}

// Per-session throttle state. Process-local (like the broadcast tail-debouncer
// in broadcast.ts): in a multi-replica deploy two replicas could each flush,
// but every derive is a full idempotent re-derive so the worst case is a
// redundant write, never a corrupt transcript.
const flushStates = new Map<string, FlushState>();

function getState(sessionId: string): FlushState {
  let st = flushStates.get(sessionId);
  if (!st) {
    st = { lastFlushAtMs: 0, stdoutSinceFlush: 0, inFlight: null, finalized: false };
    flushStates.set(sessionId, st);
  }
  return st;
}

/**
 * Full re-derive of the transcript from every job_event, then idempotent write
 * to the linked session row (messages + claudeSessionId) with the turn-table
 * dual-write. Never sets `status` — the lifecycle/sweeper paths own terminal
 * status; we only ever write the transcript so we can't fight the status owner
 * or revive a cancelled row. Always best-effort: swallows and logs all errors.
 */
async function runDerive(jobId: string, agentSessionId: string): Promise<void> {
  try {
    const events = await db
      .select({ kind: jobEvents.kind, data: jobEvents.data, ts: jobEvents.ts })
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .orderBy(asc(jobEvents.seq));

    const { messages, claudeSessionId } = buildSessionFromEvents(events);
    if (messages.length === 0 && !claudeSessionId) return;

    const [existing] = await db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        deviceId: agentSessions.deviceId,
        status: agentSessions.status,
        messages: agentSessions.messages,
        claudeSessionId: agentSessions.claudeSessionId,
        failureReason: agentSessions.failureReason,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, agentSessionId))
      .limit(1);
    if (!existing) return;

    // Never overwrite / revive a session the user explicitly cancelled — a late
    // stream that arrives after cancel must be dropped (mirrors the user PATCH
    // guard in agent-sessions/routes.ts).
    if (existing.status === 'failed' && existing.failureReason === 'user_cancelled') return;

    const prevMessages = Array.isArray(existing.messages) ? existing.messages : [];
    const updates: Record<string, unknown> = { messages, updatedAt: new Date() };
    // claudeSessionId is stable once known; set it when we have one and the row
    // doesn't already carry it (don't churn the column on every flush).
    if (claudeSessionId && existing.claudeSessionId !== claudeSessionId) {
      updates.claudeSessionId = claudeSessionId;
    }

    const { updated, sync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentSessions)
        .set(updates)
        .where(eq(agentSessions.id, agentSessionId))
        .returning();
      if (!row) throw new Error('agent session not found');
      const result = await syncTurnsWithMessages(agentSessionId, prevMessages, messages, tx);
      return { updated: row, sync: result };
    });

    // First new turn fires immediately (client learns the id); subsequent
    // appends ride the tail-debouncer to keep WS load manageable.
    sync.appended.forEach((t, i) => {
      broadcastTurnAppended(updated, t, { isStreamingTail: i > 0 });
    });
    if (sync.truncatedFromTurnIndex !== null) {
      broadcastTurnTruncated(updated, sync.truncatedFromTurnIndex);
    }
    broadcastSession(updated, 'agent-session.updated');
  } catch (err) {
    logger.warn({ err, jobId, agentSessionId }, 'session-transcript: derive failed');
  }
}

/**
 * Throttled incremental derive, called from the device events handler after a
 * batch is persisted. Fire-and-forget (returns void): kicks off a derive only
 * when the throttle gate opens and no derive is already running, so event
 * ingest is never blocked.
 */
export function maybeDeriveIncremental(
  jobId: string,
  agentSessionId: string,
  newStdoutCount: number,
): void {
  const st = getState(agentSessionId);
  st.stdoutSinceFlush += newStdoutCount;
  if (st.finalized || st.inFlight) return;

  const elapsed = Date.now() - st.lastFlushAtMs;
  if (
    st.stdoutSinceFlush < INCREMENTAL_FLUSH_STDOUT_THRESHOLD &&
    elapsed < INCREMENTAL_FLUSH_INTERVAL_MS
  ) {
    return;
  }

  st.stdoutSinceFlush = 0;
  st.lastFlushAtMs = Date.now();
  st.inFlight = runDerive(jobId, agentSessionId).finally(() => {
    const cur = flushStates.get(agentSessionId);
    if (cur) cur.inFlight = null;
  });
}

/**
 * Final, authoritative derive on job terminal (complete/fail). Awaits any
 * racing incremental flush, then writes the complete transcript. Best-effort
 * and intended to be called fire-and-forget (`void deriveSessionFinal(...)`)
 * so it can never block or hang job `/complete`.
 */
export async function deriveSessionFinal(jobId: string, agentSessionId: string): Promise<void> {
  const st = getState(agentSessionId);
  st.finalized = true;
  if (st.inFlight) {
    try {
      await st.inFlight;
    } catch {
      // runDerive never rejects, but guard regardless.
    }
  }
  await runDerive(jobId, agentSessionId);
  flushStates.delete(agentSessionId);
}
