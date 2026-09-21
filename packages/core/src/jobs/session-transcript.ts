import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnTruncated,
} from '../agent-sessions/broadcast.js';
import { syncTurnsWithMessages } from '../agent-sessions/turns-helpers.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { finalizedMerge } from '../db/transcript-marker.js';
import {
  type AgentMessage,
  createDeriveState,
  type DeriveState,
} from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';
import {
  applyCarrierRows,
  carrierLog,
  readCarrierRows,
  type TranscriptCarrier,
} from './session-transcript-carrier.js';

export type { CarrierRow, TranscriptCarrier } from './session-transcript-carrier.js';
export { contiguousPrefix } from './session-transcript-carrier.js';

const INCREMENTAL_FLUSH_INTERVAL_MS = 30_000;
const INCREMENTAL_FLUSH_STDOUT_THRESHOLD = 8;
/** A session untouched this long loses its derive state; its next flush rebuilds whole. */
const IDLE_STATE_EVICT_MS = 10 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
/** How many times a derive re-reads and re-derives after losing the compare-and-swap. */
const DERIVE_CAS_ATTEMPTS = 3;

/**
 * What one flush hands the next so the next folds only the events since.
 *
 * `messages` is deliberately NOT here: the session row holds it and every
 * derive reads that column anyway for the turn-table diff, so keeping a second
 * copy per live session would cost the 233 KB average (35 MB peak) of a
 * transcript for as long as the job runs.
 */
interface Checkpoint {
  /** Highest `job_events.seq` folded into the transcript this checkpoint wrote. */
  lastSeq: number;
  claudeSessionId: string | null;
  startedAt: Map<string, number>;
  makeId: () => string;
  fingerprint: string;
}

interface FlushState {
  lastFlushAtMs: number;
  /** Last time anything touched this session; the idle sweep reads it. */
  lastTouchedAtMs: number;
  stdoutSinceFlush: number;
  /** In-flight derive promise, so a final flush can await a racing incremental
   *  one before writing the authoritative transcript (prevents a late partial
   *  write from clobbering the complete one). */
  inFlight: Promise<void> | null;
  /** Once the job is terminal, incremental flushes no-op — the final derive owns
   *  the last write. */
  finalized: boolean;
  checkpoint: Checkpoint | null;
}

const flushStates = new Map<string, FlushState>();

let lastSweepAtMs = 0;

function sweepIdleStates(now: number): void {
  if (now - lastSweepAtMs < IDLE_SWEEP_INTERVAL_MS) return;
  lastSweepAtMs = now;
  for (const [sessionId, st] of flushStates) {
    if (!st.inFlight && now - st.lastTouchedAtMs > IDLE_STATE_EVICT_MS) {
      flushStates.delete(sessionId);
    }
  }
}

function getState(sessionId: string): FlushState {
  const now = Date.now();
  sweepIdleStates(now);
  let st = flushStates.get(sessionId);
  if (!st) {
    st = {
      lastFlushAtMs: 0,
      lastTouchedAtMs: now,
      stdoutSinceFlush: 0,
      inFlight: null,
      finalized: false,
      checkpoint: null,
    };
    flushStates.set(sessionId, st);
  }
  st.lastTouchedAtMs = now;
  return st;
}

/** The stored derived result's fingerprint, computed by Postgres over the
 *  stored bytes themselves rather than over a re-serialized copy of them. */
const storedFingerprint = sql<string>`md5(${agentSessions.messages}::text) || ':' || md5(coalesce(${agentSessions.claudeSessionId}, ''))`;

const notUserCancelled = sql`not (${agentSessions.status} = 'failed' and ${agentSessions.failureReason} is not distinct from 'user_cancelled')`;

interface Resumed {
  lastSeq: number;
  state: DeriveState;
}

/**
 * Decide whether this flush may fold, or must rebuild from every event. Returns
 * null for the rebuild, having said on the log why — a checkpoint that cannot
 * be trusted costs a full re-derive and is never allowed to cost a partial
 * transcript.
 */
function resumeFrom(
  cp: Checkpoint | null,
  fingerprint: string,
  prevMessages: AgentMessage[],
  ctx: Record<string, unknown>,
): Resumed | null {
  if (!cp) {
    logger.debug(ctx, 'session-transcript: no checkpoint — deriving from every event');
    return null;
  }
  if (cp.fingerprint !== fingerprint) {
    logger.warn(
      { ...ctx, lastSeq: cp.lastSeq },
      'session-transcript: the stored transcript is not the one this checkpoint wrote — deriving from every event',
    );
    return null;
  }
  return {
    lastSeq: cp.lastSeq,
    state: {
      messages: prevMessages.slice(),
      claudeSessionId: cp.claudeSessionId,
      startedAt: cp.startedAt,
      makeId: cp.makeId,
    },
  };
}

type DeriveOutcome = 'written' | 'nothing-to-write' | 'lost-race';

/**
 * One derive attempt: read the row, decide fold-or-rebuild, read the events it
 * needs, fold, and write under a compare-and-swap. Never sets `status` — the
 * lifecycle/sweeper paths own terminal status; we only ever write the transcript
 * so we can't fight the status owner or revive a cancelled row.
 */
async function deriveOnce(
  carrier: TranscriptCarrier,
  agentSessionId: string,
  st: FlushState | null,
  finalizedAt: Date | null,
): Promise<DeriveOutcome> {
  const log = carrierLog(carrier, agentSessionId);
  const [existing] = await db
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
      status: agentSessions.status,
      messages: agentSessions.messages,
      fingerprint: storedFingerprint,
      claudeSessionId: agentSessions.claudeSessionId,
      failureReason: agentSessions.failureReason,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, agentSessionId))
    .limit(1);
  if (!existing) return 'nothing-to-write';

  if (existing.status === 'failed' && existing.failureReason === 'user_cancelled') {
    return 'nothing-to-write';
  }

  const prevMessages = Array.isArray(existing.messages)
    ? (existing.messages as AgentMessage[])
    : [];
  const resumed = resumeFrom(st?.checkpoint ?? null, existing.fingerprint, prevMessages, log);

  const rows = await readCarrierRows(carrier, agentSessionId, resumed?.lastSeq ?? 0);

  if (!resumed && rows.length === 0 && prevMessages.length > 0) {
    logger.warn(
      log,
      'session-transcript: nothing to rebuild from and a transcript already stored — leaving it as it stands',
    );
    return 'nothing-to-write';
  }

  const state = resumed?.state ?? createDeriveState();
  applyCarrierRows(state, rows);
  const { messages, claudeSessionId } = state;
  if (messages.length === 0 && !claudeSessionId) return 'nothing-to-write';
  const lastSeq = rows[rows.length - 1]?.seq ?? resumed?.lastSeq ?? 0;

  const written = await writeTranscript(agentSessionId, {
    baseline: existing.fingerprint,
    prevMessages,
    messages,
    claudeSessionId:
      claudeSessionId && existing.claudeSessionId !== claudeSessionId ? claudeSessionId : null,
    finalizedAt,
  });
  if (!written) {
    const [now] = await db
      .select({ status: agentSessions.status, failureReason: agentSessions.failureReason })
      .from(agentSessions)
      .where(eq(agentSessions.id, agentSessionId))
      .limit(1);
    if (!now) return 'nothing-to-write';
    if (now.status === 'failed' && now.failureReason === 'user_cancelled') {
      logger.debug(
        log,
        'session-transcript: the session was cancelled under this derive — nothing written',
      );
      return 'nothing-to-write';
    }
    return 'lost-race';
  }

  if (st) {
    st.checkpoint = {
      lastSeq,
      claudeSessionId: state.claudeSessionId,
      startedAt: state.startedAt,
      makeId: state.makeId,
      fingerprint: written.fingerprint,
    };
  }

  written.sync.appended.forEach((t, i) => {
    broadcastTurnAppended(written.updated, t, { isStreamingTail: i > 0 });
  });
  if (written.sync.truncatedFromTurnIndex !== null) {
    broadcastTurnTruncated(written.updated, written.sync.truncatedFromTurnIndex);
  }
  broadcastSession(written.updated, 'agent-session.updated');
  return 'written';
}

interface TranscriptWrite {
  baseline: string;
  prevMessages: AgentMessage[];
  messages: AgentMessage[];
  claudeSessionId: string | null;
  /** Set only by the FINAL derive; see `FINALIZED_MARKER`. */
  finalizedAt: Date | null;
}

type WriteResult = {
  updated: typeof agentSessions.$inferSelect;
  sync: Awaited<ReturnType<typeof syncTurnsWithMessages>>;
  fingerprint: string;
};

/** The transcript write and the turn-table dual write, or null when the stored
 *  transcript moved between the read and this write. */
async function writeTranscript(
  agentSessionId: string,
  w: TranscriptWrite,
): Promise<WriteResult | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentSessions)
      .set({
        messages: w.messages,
        updatedAt: new Date(),
        ...(w.claudeSessionId ? { claudeSessionId: w.claudeSessionId } : {}),
        ...(w.finalizedAt ? { metadata: finalizedMerge(w.finalizedAt) } : {}),
      })
      .where(
        and(
          eq(agentSessions.id, agentSessionId),
          eq(storedFingerprint, w.baseline),
          notUserCancelled,
        ),
      )
      .returning({ ...getTableColumns(agentSessions), fingerprint: storedFingerprint });
    if (!row) return null;
    const { fingerprint, ...updated } = row;
    const sync = await syncTurnsWithMessages(agentSessionId, w.prevMessages, w.messages, tx);
    return { updated, sync, fingerprint };
  });
}

/**
 * Record the finalisation on its own, for the one case the transcript write
 * cannot carry it: a final derive that found nothing to write.
 */
async function markFinalized(agentSessionId: string, at: Date): Promise<void> {
  try {
    await db
      .update(agentSessions)
      .set({ metadata: finalizedMerge(at), updatedAt: new Date() })
      .where(eq(agentSessions.id, agentSessionId));
  } catch (err) {
    logger.warn({ err, agentSessionId }, 'session-transcript: could not record the finalisation');
  }
}

/**
 * Derive the transcript and write it, retrying against what now stands whenever
 * the compare-and-swap loses. Always best-effort: swallows and logs all errors.
 */
async function runDerive(
  carrier: TranscriptCarrier,
  agentSessionId: string,
  finalizedAt: Date | null = null,
): Promise<DeriveOutcome> {
  const st = flushStates.get(agentSessionId) ?? null;
  const log = carrierLog(carrier, agentSessionId);
  try {
    for (let attempt = 1; attempt <= DERIVE_CAS_ATTEMPTS; attempt += 1) {
      const outcome = await deriveOnce(carrier, agentSessionId, st, finalizedAt);
      if (outcome !== 'lost-race') return outcome;
      if (st) st.checkpoint = null;
      logger.warn(
        { ...log, attempt },
        'session-transcript: the stored transcript moved under this derive — re-deriving against it',
      );
    }
    logger.warn(
      { ...log, attempts: DERIVE_CAS_ATTEMPTS },
      'session-transcript: lost the transcript write every attempt — nothing written',
    );
  } catch (err) {
    if (st) st.checkpoint = null;
    logger.warn({ err, ...log }, 'session-transcript: derive failed');
  }
  return 'lost-race';
}

/**
 * Throttled incremental derive, called from the device events handler after a
 * batch is persisted. Kicks off a derive only when the throttle gate opens and
 * no derive is already running, so event ingest is never blocked — the handler
 * voids what comes back.
 *
 * Returns the derive it started, or null when the gate stayed shut, so a caller
 * that needs the flush to have happened can await it instead of polling the row
 * for a write that is fire-and-forget everywhere else.
 */
export function maybeDeriveIncremental(
  jobId: string,
  agentSessionId: string,
  newStdoutCount: number,
): Promise<void> | null {
  return maybeDeriveIncrementalFor({ kind: 'job', jobId }, agentSessionId, newStdoutCount);
}

/** The same throttled flush, for whichever carrier holds this session's lines. */
export function maybeDeriveIncrementalFor(
  carrier: TranscriptCarrier,
  agentSessionId: string,
  newStdoutCount: number,
): Promise<void> | null {
  const st = getState(agentSessionId);
  st.stdoutSinceFlush += newStdoutCount;
  if (st.finalized || st.inFlight) return null;

  const elapsed = Date.now() - st.lastFlushAtMs;
  if (
    st.stdoutSinceFlush < INCREMENTAL_FLUSH_STDOUT_THRESHOLD &&
    elapsed < INCREMENTAL_FLUSH_INTERVAL_MS
  ) {
    return null;
  }

  st.stdoutSinceFlush = 0;
  st.lastFlushAtMs = Date.now();
  st.inFlight = runDerive(carrier, agentSessionId)
    .then(() => undefined)
    .finally(() => {
      const cur = flushStates.get(agentSessionId);
      if (cur) cur.inFlight = null;
    });
  return st.inFlight;
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
  st.checkpoint = null;
  const finalizedAt = new Date();
  const outcome = await runDerive({ kind: 'job', jobId }, agentSessionId, finalizedAt);
  if (outcome === 'nothing-to-write') await markFinalized(agentSessionId, finalizedAt);
  flushStates.delete(agentSessionId);
}

export async function deriveChatTurnFinal(agentSessionId: string): Promise<boolean> {
  const st = getState(agentSessionId);
  if (st.inFlight) {
    try {
      await st.inFlight;
    } catch {
      // runDerive never rejects, but guard regardless.
    }
  }
  const finalizedAt = new Date();
  const outcome = await runDerive({ kind: 'chat' }, agentSessionId, finalizedAt);
  if (outcome === 'nothing-to-write') await markFinalized(agentSessionId, finalizedAt);
  return outcome === 'written';
}
