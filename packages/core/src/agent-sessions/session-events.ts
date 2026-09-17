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
import { sql } from 'drizzle-orm';
import type { db as dbClient } from '../db/client.js';
import { agentSessionEvents } from '../db/schema.js';
import { toCanonicalMessages } from './canonical-legacy.js';

type Tx = Parameters<Parameters<typeof dbClient.transaction>[0]>[0];
export type DbOrTx = typeof dbClient | Tx;

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
  const carryIn: Record<string, unknown>[] = [];
  if (seq === 1 && args.priorMessages.length > 0) {
    const converted = toCanonicalMessages(args.priorMessages);
    if (!converted.ok) {
      throw new Error(
        `agent_session_events: cannot carry this session's standing transcript into its carrier — messages[${converted.index}] ${converted.why}`,
      );
    }
    carryIn.push(...converted.messages);
  }

  const values = [...carryIn, args.entry].map((entry, i) => ({
    agentSessionId,
    kind: 'seed' as const,
    data: { entry },
    seq: seq + i,
    ts: args.at,
  }));
  await tx.insert(agentSessionEvents).values(values);
  seq += values.length - 1;
  return { lastSeq: seq };
}
