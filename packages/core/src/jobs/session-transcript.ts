/**
 * ISS-283 — derive the canonical `agent_sessions` transcript for CLI-runner
 * jobs from the `job_events` core already stores.
 *
 * The `forge-runner` CLI streams every raw Claude stream-json line as a
 * `stdout` job_event (and `claudeSessionId` as a `progress` event) but never
 * PATCHes the linked `agent_sessions` row — it can't, because that route is
 * user-JWT-gated and the runner holds only a device token. So the
 * session-detail page is empty for CLI-run jobs.
 *
 * Instead of a new device write-path + a Rust parser port, we derive the
 * transcript server-side on the device-authed paths core already owns: the
 * events handler (throttled, incremental) and the lifecycle handlers (final,
 * authoritative). Every write here is best-effort — a parse/DB hiccup must
 * never block event ingest or job `/complete`.
 *
 * ISS-1030 — the same fold, over a second carrier. A chat turn has no `jobs`
 * row (`transport/agent_sessions.rs`: "Chat never touches the `jobs` table"), so
 * its raw lines land in `agent_session_events` instead; everything below reads
 * whichever carrier it is handed and there is still one reducer, one CAS writer
 * and one broadcast.
 *
 * ISS-1020 — an incremental flush folds only the events past its checkpoint.
 * The final derive is still a full rebuild from every event and is still the
 * owner of the terminal transcript; so is every fallback. What makes the two
 * paths one computation rather than two is `agent-stream-parser.ts`: the
 * incremental flush resumes the SAME fold `buildSessionFromEvents` runs, so
 * there is no second reducer to drift.
 */
import { and, asc, eq, getTableColumns, gt, sql } from 'drizzle-orm';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnTruncated,
} from '../agent-sessions/broadcast.js';
import { syncTurnsWithMessages } from '../agent-sessions/turns-helpers.js';
import { db } from '../db/client.js';
import { agentSessionEvents, agentSessions, jobEvents } from '../db/schema.js';
import { finalizedMerge } from '../db/transcript-marker.js';
import {
  type AgentMessage,
  applyEventsToState,
  createDeriveState,
  type DeriveState,
  mergeMessages,
} from '../lib/agent-stream-parser.js';
import { logger } from '../logger.js';

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
  // cm:guard `md5(messages::text)` of the row this checkpoint wrote, read back INSIDE the transaction that wrote it. It is what stops an incremental flush folding onto a transcript this process did not write — another replica's rebuild, a `PATCH /api/agent-sessions/:id` carrying `messages`, or its own write that a later one replaced. Weakening it to a count, or to the ids alone, re-admits a content-only foreign write in silence, and the transcript that comes out is a plausible one nobody can tell from the real thing.
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

// cm:guard process-local, like the broadcast tail-debouncer in broadcast.ts, so in a multi-replica deploy two replicas each hold their own. Neither can corrupt the other's transcript: a checkpoint is only ever resumed against a row still answering with the fingerprint it wrote, and every write is compare-and-swapped on that same fingerprint, so the replica whose baseline moved loses the swap and re-derives against what now stands rather than overwriting it with something older. Both halves are load-bearing — keep only the fingerprint and a late write still clobbers a newer transcript; keep only the swap and a flush still folds onto an array it did not write.
const flushStates = new Map<string, FlushState>();

let lastSweepAtMs = 0;

// cm:why swept rather than deleted on job end: `deriveSessionFinal` is the only deleter, and a cancelled or abandoned job never reaches it. That leak was one small object per session before ISS-1020 and is now a checkpoint carrying `startedAt`, which grows with the job's tool calls — so the map has to bound itself.
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

// cm:guard the fingerprint covers BOTH columns a derive writes, and it has to: `claudeSessionId` is half the derived result and it moves without `messages` moving at all, so a fingerprint over the transcript alone lets a flush holding a stale prefix put an old session id back over a newer one and sit there — the transcript looks right and the id is a lie. The two md5s are concatenated rather than hashed together so no transcript ending in an id's first characters can collide with a shorter one.
/** The stored derived result's fingerprint, computed by Postgres over the
 *  stored bytes themselves rather than over a re-serialized copy of them. */
const storedFingerprint = sql<string>`md5(${agentSessions.messages}::text) || ':' || md5(coalesce(${agentSessions.claudeSessionId}, ''))`;

// cm:guard the cancel is re-checked in the WRITE and not only in the read above, because a cancel moves neither column the fingerprint covers: it lands on `status` and `failure_reason`, so a cancel committing between the two would leave the swap intact and the late stream would be written, broadcast and dual-written to the turn table by the very derive the read-time guard says drops it.
// cm:guard `is not distinct from`, never `=`: `failure_reason` is nullable, and a plain equality makes the whole conjunction NULL for a failed session carrying no reason — `NOT NULL` is NULL, the row matches nothing, and every derive on such a session silently writes nothing at all.
const notUserCancelled = sql`not (${agentSessions.status} = 'failed' and ${agentSessions.failureReason} is not distinct from 'user_cancelled')`;

/**
 * Where one session's raw events live. A `job` carrier reads `job_events` by
 * `job_id`; a `chat` carrier reads `agent_session_events` by `agent_session_id`.
 * Nothing else about a derive differs, which is the point: one reducer, one
 * compare-and-swap writer, one broadcast, two tables.
 */
export type TranscriptCarrier = { kind: 'job'; jobId: string } | { kind: 'chat' };

/** The log fields that name which carrier a line is about. */
function carrierLog(carrier: TranscriptCarrier, agentSessionId: string) {
  return carrier.kind === 'job'
    ? { jobId: carrier.jobId, agentSessionId }
    : { carrier: 'chat' as const, agentSessionId };
}

/** One carrier row, narrowed to what the fold and the checkpoint read. */
export interface CarrierRow {
  kind: string;
  data: unknown;
  ts: Date;
  seq: number;
}

/**
 * The unbroken run of `rows` starting at `afterSeq + 1`, stopping at the first gap.
 *
 * cm:guard this is a correctness requirement and not tidiness.
 * `applyEventsToState` states its own contract — the events it is handed MUST
 * start where the last call left off — because that is what makes an incremental
 * flush the SAME computation as a full re-derive rather than an approximation of
 * one. Before ISS-1030 nothing could produce a hole: `jobs/events-routes.ts`
 * assigns `seq` server-side under an advisory lock, so insert order IS seq order.
 * `agent_session_events` moves that assignment to the writer, so a batch that
 * lands after a later one is now possible, and the checkpoint may advance only
 * over the unbroken run. Rows past a gap are read again on the next pass, once
 * the hole is filled; a hole that never fills holds the derive at the gap instead
 * of skipping it for ever.
 */
export function contiguousPrefix(rows: readonly CarrierRow[], afterSeq: number): CarrierRow[] {
  let expected = afterSeq + 1;
  const prefix: CarrierRow[] = [];
  for (const row of rows) {
    if (row.seq !== expected) break;
    prefix.push(row);
    expected += 1;
  }
  return prefix;
}

/**
 * The rows of this carrier after `afterSeq`, in seq order, truncated at the
 * first gap — see `contiguousPrefix` for why the truncation is load-bearing.
 */
async function readCarrierRows(
  carrier: TranscriptCarrier,
  agentSessionId: string,
  afterSeq: number,
): Promise<CarrierRow[]> {
  const rows: CarrierRow[] =
    carrier.kind === 'job'
      ? await db
          .select({
            kind: jobEvents.kind,
            data: jobEvents.data,
            ts: jobEvents.ts,
            seq: jobEvents.seq,
          })
          .from(jobEvents)
          .where(
            afterSeq > 0
              ? and(eq(jobEvents.jobId, carrier.jobId), gt(jobEvents.seq, afterSeq))
              : eq(jobEvents.jobId, carrier.jobId),
          )
          .orderBy(asc(jobEvents.seq))
      : await db
          .select({
            kind: agentSessionEvents.kind,
            data: agentSessionEvents.data,
            ts: agentSessionEvents.ts,
            seq: agentSessionEvents.seq,
          })
          .from(agentSessionEvents)
          .where(
            afterSeq > 0
              ? and(
                  eq(agentSessionEvents.agentSessionId, agentSessionId),
                  gt(agentSessionEvents.seq, afterSeq),
                )
              : eq(agentSessionEvents.agentSessionId, agentSessionId),
          )
          .orderBy(asc(agentSessionEvents.seq));

  return contiguousPrefix(rows, afterSeq);
}

/**
 * Fold one contiguous run of carrier rows into `state`.
 *
 * Every row whose payload is a raw stream-json line goes through
 * `applyEventsToState`, which is the one reducer for that wire. A `seed` row is
 * the one thing that wire cannot carry: `parseStreamMessages` answers
 * `{messages:[]}` for a `user` line holding no `tool_result`, so the prompt a
 * person typed is not derivable from the stream at all, and core writes it as a
 * canonical entry of its own. It is appended through `mergeMessages`, the same
 * merge every other entry goes through, rather than pushed by a rule of its own.
 */
function applyCarrierRows(state: DeriveState, rows: CarrierRow[]): void {
  for (const row of rows) {
    if (row.kind !== 'seed') {
      applyEventsToState(state, [row]);
      continue;
    }
    const entry = (row.data as { entry?: unknown } | null | undefined)?.entry;
    if (entry && typeof entry === 'object') mergeMessages(state.messages, [entry as AgentMessage]);
  }
}

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
    // cm:guard the fold gets a COPY. `mergeMessages` replaces the tail of the array it is handed and pushes onto it, and the array read off the row is also the pre-flush baseline `syncTurnsWithMessages` diffs against — share one array between the two and the turn table silently stops recording the turns this flush appended, while the transcript column still looks right.
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

  // cm:guard never overwrite or revive a session the user explicitly cancelled: a stream arriving after the cancel is dropped, and the derive is one of the doors it can arrive through.
  // cm:edge lockstep -> packages/core/src/agent-sessions/routes.ts — the same rule guards the user PATCH, and it has to be on both: a late write reaching the row by the derive and one reaching it by the PATCH are the same fact arriving by two doors, and a guard on one leaves the other reviving the row.
  if (existing.status === 'failed' && existing.failureReason === 'user_cancelled') {
    return 'nothing-to-write';
  }

  const prevMessages = Array.isArray(existing.messages)
    ? (existing.messages as AgentMessage[])
    : [];
  const resumed = resumeFrom(st?.checkpoint ?? null, existing.fingerprint, prevMessages, log);

  const rows = await readCarrierRows(carrier, agentSessionId, resumed?.lastSeq ?? 0);

  // cm:guard a REBUILD over a history that does not start at seq 1 is the one
  // failure this whole path exists to avoid: a rebuild replaces the transcript
  // outright, so folding a suffix would overwrite a complete stored record with a
  // shorter one and — on the final derive — mark that truncation finalised.
  // `readCarrierRows` answers with nothing when the first row is not the one the
  // cursor expects, so an empty answer with a stored transcript standing means
  // the carrier can no longer rebuild it. ISS-1027's retention sweep is what
  // makes that state reachable; `retention/statements.ts` releases a session's
  // rows all or none for the same reason, and both halves are kept because
  // either one alone still admits the truncation.
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
    // cm:guard zero rows is two outcomes wearing one face, and telling them apart is the point: the swap losing is retried against what now stands, the cancel firing is the answer. Collapse them and a cancelled session burns three re-derives and then logs that the write was lost, which reads as a fault where there was none.
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

  // cm:why the FIRST new turn fires immediately and every append after it rides the tail-debouncer: the client learns the turn id from that first broadcast and cannot render the stream without it, while the rest are the same turn growing and would cost one frame each.
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
  // cm:why the SET list is written as a literal so `kernel-marker-guard.test.ts` can see it carries no `status` — this is the transcript flush, the hottest write on the session table, and it is the one place worth proving status-free rather than paying a marker round-trip per flush. `claudeSessionId` is stable once known, so it is spread in only when the row does not already carry it rather than churning the column on every flush.
  // cm:guard the WHERE carries the fingerprint the derive read, so a transcript replaced since that read is never overwritten by one computed from the old bytes. Dropping it restores an unconditional write, and with it the case ISS-1020 names: a slow incremental flush committing after the final rebuild and putting the terminal transcript back to an earlier seq.
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
      // cm:why the next checkpoint's fingerprint comes back on this RETURNING rather than from a select after it. RETURNING evaluates against the row as written, so it is the same answer a re-read would give — and a re-read is a second detoast of the largest jsonb column in the schema, on the write this issue exists to make cheaper.
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
    // cm:guard a checkpoint may only ever describe a write that committed, and this one did not. Leaving it standing is how the next flush folds new events onto a transcript that was never stored.
    if (st) st.checkpoint = null;
    logger.warn({ err, ...log }, 'session-transcript: derive failed');
  }
  // cm:guard both fall-throughs above are a derive that WROTE NOTHING, and this is the answer that says so. Returning 'written' or 'nothing-to-write' here would tell `deriveSessionFinal` to stamp the finalisation marker for a transcript that was never stored, and ISS-1027's retention rule reads that marker as permission to delete the events it would have been built from.
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
  // cm:guard the terminal transcript is a full rebuild from every event, always. Dropping the checkpoint here is what makes that true: leave it and the last derive a session ever gets is an incremental one, and any event the cursor skipped is skipped for good.
  st.checkpoint = null;
  const finalizedAt = new Date();
  const outcome = await runDerive({ kind: 'job', jobId }, agentSessionId, finalizedAt);
  // cm:guard a derive with nothing to write still FINALISED the session, and the marker has to say so: a job that produced no parseable event has no transcript to protect, and withholding the marker would hold its `job_events` rows for ever under ISS-1027's retention rule while the repair pass re-derived nothing, night after night. 'lost-race' is the other direction and gets no marker at all.
  if (outcome === 'nothing-to-write') await markFinalized(agentSessionId, finalizedAt);
  flushStates.delete(agentSessionId);
}

/**
 * The authoritative derive at the end of one CHAT turn.
 *
 * A chat session has no terminal event of its own: it ends a turn, the person
 * types again, and it runs another. So this fires per turn and the session's
 * whole life is one growing carrier.
 *
 * cm:guard it does NOT drop the checkpoint, and the job path above does. That is
 * not an oversight and not a weaker rule: the reason the job path rebuilds is
 * that an incremental cursor could once step over an event, and
 * `readCarrierRows` is what removed that possibility — it stops at the first gap
 * rather than passing it, so a checkpoint can no longer name a seq the fold
 * skipped. Rebuilding every turn instead would re-fold the session's entire
 * history on each one, which is quadratic over the life of a long conversation.
 * If the prefix rule is ever relaxed, this has to become a rebuild again.
 *
 * cm:guard WHO may call this is the caller's gate and deliberately not a query
 * here. A daemon on the previous release still PATCHes its whole `messages`
 * array, and core writes a prompt seed for every turn whoever runs it — so
 * deriving on a session whose carrier holds prompts alone would replace that
 * daemon's transcript with the questions and none of the answers.
 * `agent-sessions/routes.ts` gates on the shape of the PATCH, which says the
 * same thing without a read: a terminal PATCH from a device carrying no
 * `messages` is a daemon that delivered its lines instead.
 */
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
