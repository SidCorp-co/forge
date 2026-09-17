/**
 * ISS-1030 — the rows core itself writes into a chat session's carrier.
 *
 * `agent_session_events` holds the raw stream-json lines a chat turn produced,
 * and the transcript is folded from them. One thing that stream cannot carry is
 * the prompt the person typed: `parseStreamMessages` answers `{messages:[]}` for
 * a `user` line whose content holds no `tool_result`, and the CLI's
 * `--replay-user-messages` echo is exactly such a line. So a transcript rebuilt
 * from the wire alone would hold every answer and no question.
 *
 * Core therefore writes the user turn as a `seed` row carrying the canonical
 * entry, at its own place in the same `seq` run. That is what makes a full
 * re-derive of a chat session equal to the incremental one — which is the
 * property the whole checkpoint design rests on.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';
import { toCanonicalMessages } from './canonical-legacy.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/** The highest `seq` this session's carrier holds, under a lock that makes it usable. */
// cm:why an ADVISORY lock here and none on `POST /:id/events`: this is the one
// writer that computes `MAX(seq)` itself, and the frontier is an aggregate, so
// there is no row to take `FOR UPDATE`. The device route needs no lock because
// the runner assigns its own `seq` and the unique index settles a collision.
async function nextSeq(tx: DbOrTx, agentSessionId: string): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${agentSessionId}))`);
  const rows = await tx.execute<{ max_seq: number | string | null }>(sql`
    SELECT COALESCE(MAX(seq), 0) AS max_seq
    FROM agent_session_events
    WHERE agent_session_id = ${agentSessionId}
  `);
  const first = rows[0] as { max_seq: number | string | null } | undefined;
  return Number(first?.max_seq ?? 0) + 1;
}

/** What `seedTurn` answers with: the seq it took, so the turn can be numbered from it. */
export interface SeedResult {
  /** The `seq` of the last row this call wrote. */
  lastSeq: number;
}

/**
 * Put this turn's user entry in the carrier, carrying in any transcript that
 * stood before the carrier existed.
 *
 * cm:guard the carry-in is not a nicety. A session that ran under the previous
 * runner release holds its transcript in `agent_sessions.messages` and has no
 * carrier rows at all; the first turn on the new release would otherwise give
 * that session a carrier starting at its newest turn, and the first rebuild
 * would replace the whole conversation with that one turn. Writing the standing
 * transcript in as `seed` rows first is what makes the carrier a complete
 * account of the session from the moment it exists.
 */
export async function seedTurn(
  tx: DbOrTx,
  agentSessionId: string,
  args: { priorMessages: unknown[]; entry: Record<string, unknown>; at: Date },
): Promise<SeedResult> {
  let seq = await nextSeq(tx, agentSessionId);
  const rows: Array<{ kind: 'seed' | 'snapshot'; data: Record<string, unknown> }> = [];
  if (seq === 1 && args.priorMessages.length > 0) {
    const converted = toCanonicalMessages(args.priorMessages);
    if (!converted.ok) {
      throw new Error(
        `agent_session_events: cannot carry this session's standing transcript into its carrier — messages[${converted.index}] ${converted.why}`,
      );
    }
    // cm:why ONE `snapshot` and not one `seed` per entry: the standing transcript
    // is what the session's record WAS at this seq, so folding it as a
    // replacement reproduces it exactly, while merging it entry by entry runs it
    // through `mergeMessages` — which folds consecutive assistant entries
    // together — and hands back a history the session never had.
    rows.push({ kind: 'snapshot', data: { entries: converted.messages } });
  }
  rows.push({ kind: 'seed', data: { entry: args.entry } });

  const values = rows.map((row, i) => ({
    agentSessionId,
    kind: row.kind,
    data: row.data,
    seq: seq + i,
    ts: args.at,
  }));
  await tx.insert(agentSessionEvents).values(values);
  seq += values.length - 1;
  return { lastSeq: seq };
}

/**
 * Record a transcript that was written WHOLESALE, so the carrier keeps being a
 * complete account of the session.
 *
 * cm:guard this is the other half of the amnesty, and without it the amnesty
 * ends in the loss it exists to prevent. Core dispatches a turn to a daemon on
 * the previous release: the carrier gets the seeded prompt, the daemon's answer
 * arrives on `PATCH messages` and never reaches the carrier. Upgrade that box
 * and the next turn's derive folds a carrier holding prompts and this turn's
 * lines, then writes it over a transcript that had the earlier answers in it.
 * The carrier is non-empty, so `seedTurn`'s carry-in does not fire either —
 * non-emptiness is not completeness, and this row is what makes it so.
 */
export async function recordReportedTranscript(
  tx: DbOrTx,
  agentSessionId: string,
  entries: Record<string, unknown>[],
  at: Date,
): Promise<void> {
  const seq = await nextSeq(tx, agentSessionId);
  await tx.insert(agentSessionEvents).values({
    agentSessionId,
    kind: 'snapshot' as const,
    data: { entries },
    seq,
    ts: at,
  });
}

/**
 * Record what went wrong with a turn, as a transcript entry of its own.
 *
 * cm:guard core writes this entry and the runner does not. The runner reports a
 * string on `PATCH /:id`; making it send a `system` message of its own is what
 * made it a producer of transcript entries, and the reason every chat session's
 * transcript was a different shape from every pipeline session's.
 * cm:guard a turn that ends badly must SAY so on the transcript. A refused batch
 * or an undelivered tail that only logged would leave a turn that stops
 * mid-sentence and a session that reads as having finished — which is the silent
 * substitution this repository refuses by name.
 */
export async function recordTurnError(agentSessionId: string, error: string): Promise<void> {
  const at = new Date();
  await db.transaction(async (tx) => {
    const seq = await nextSeq(tx, agentSessionId);
    await tx.insert(agentSessionEvents).values({
      agentSessionId,
      kind: 'seed' as const,
      data: {
        entry: {
          id: randomUUID(),
          type: 'system',
          timestamp: at.getTime(),
          content: error,
        },
      },
      seq,
      ts: at,
    });
  });
}
