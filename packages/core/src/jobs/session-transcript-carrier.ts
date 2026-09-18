/**
 * ISS-1030 — the carrier a transcript is folded from, and how its rows are read.
 *
 * Split out of `session-transcript.ts`, which owns the derive itself: this file
 * is the part that answers "which rows may this fold see, and what does each one
 * mean". The two carriers differ here and nowhere else.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobEvents } from '../db/schema.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';
import {
  type AgentMessage,
  applyEventsToState,
  type DeriveState,
  mergeMessages,
} from '../lib/agent-stream-parser.js';

/**
 * Where one session's raw events live. A `job` carrier reads `job_events` by
 * `job_id`; a `chat` carrier reads `agent_session_events` by `agent_session_id`.
 * Nothing else about a derive differs, which is the point: one reducer, one
 * compare-and-swap writer, one broadcast, two tables.
 */
export type TranscriptCarrier = { kind: 'job'; jobId: string } | { kind: 'chat' };

/** The log fields that name which carrier a line is about. */
export function carrierLog(carrier: TranscriptCarrier, agentSessionId: string) {
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
 * one. It applies to the CHAT carrier, and only there: `jobs/events-routes.ts`
 * assigns `seq` server-side under an advisory lock, so a job's insert order IS
 * seq order. `agent_session_events` moves that assignment to the writer, so a
 * batch that lands after a later one is now possible, and the checkpoint may
 * advance only over the unbroken run. Rows past a gap are read again on the next pass, once
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
 * The rows of this carrier after `afterSeq`, in seq order — truncated at the
 * first gap on the CHAT carrier only.
 *
 * cm:guard the truncation follows who assigns `seq`, and applying it to both
 * carriers is a regression rather than symmetry. `jobs/events-routes.ts` assigns
 * `seq` server-side under an advisory lock, so a job's rows cannot arrive out of
 * order — but they CAN be swept: retention deletes old `job_events`, and a
 * rebuild from `afterSeq = 0` then starts at a seq that is not 1. Truncating
 * there would fold nothing and hold the transcript at a hole that can never
 * fill. The runner assigns `seq` on the chat carrier, where a late batch is
 * exactly the hole `contiguousPrefix` exists to wait for.
 */
export async function readCarrierRows(
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

  return carrier.kind === 'chat' ? contiguousPrefix(rows, afterSeq) : rows;
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
export function applyCarrierRows(state: DeriveState, rows: CarrierRow[]): void {
  for (const row of rows) {
    // cm:guard a `snapshot` REPLACES what the fold has accumulated, because that
    // is what the write it records did to the transcript: a daemon on the
    // previous release reporting its whole `messages` array, or a person editing
    // a turn. Merging it instead would leave the entries it replaced standing
    // beside their replacements, and dropping the row would let the next rebuild
    // hand back the conversation without that turn in it.
    if (row.kind === 'snapshot') {
      const entries = (row.data as { entries?: unknown } | null | undefined)?.entries;
      if (Array.isArray(entries)) {
        state.messages.length = 0;
        state.messages.push(...(entries as AgentMessage[]));
      }
      continue;
    }
    if (row.kind !== 'seed') {
      applyEventsToState(state, [row]);
      continue;
    }
    const entry = (row.data as { entry?: unknown } | null | undefined)?.entry;
    if (entry && typeof entry === 'object') mergeMessages(state.messages, [entry as AgentMessage]);
  }
}
