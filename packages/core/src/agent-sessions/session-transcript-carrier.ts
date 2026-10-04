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

export function applyCarrierRows(state: DeriveState, rows: CarrierRow[]): void {
  for (const row of rows) {
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
