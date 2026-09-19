import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessionEvents } from '../db/schema-agent-session-events.js';
import { toCanonicalMessages } from './canonical-legacy.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = typeof db | Tx;

/** The highest `seq` this session's carrier holds, under a lock that makes it usable. */
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
