/**
 * ISS-50 — backfill `agent_session_turns` from existing `agent_sessions.messages`
 * jsonb blobs. Runs once before the dual-write code is deployed.
 *
 * Usage:
 *   tsx packages/core/scripts/backfill-agent-session-turns.ts [--dry-run] [--batch-size=100]
 *
 * Restartable: skips sessions that already have any turn rows. Cursor pagination
 * over `agent_sessions.id` so a re-run after a crash picks up where it stopped.
 */
import { asc, eq, gt, sql } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { agentSessions, agentSessionTurns } from '../src/db/schema.js';
import { messageRoleToTurnRole, normalizeTurnContent } from '../src/agent-sessions/turns-helpers.js';

interface Options {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, batchSize: 100 };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('--batch-size=')) {
      const n = Number(a.split('=')[1]);
      if (Number.isFinite(n) && n > 0) opts.batchSize = n;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(`[backfill] dry-run=${opts.dryRun} batch-size=${opts.batchSize}`);

  let cursor: string | null = null;
  let scannedSessions = 0;
  let backfilledSessions = 0;
  let insertedRows = 0;
  let skippedMalformed = 0;

  while (true) {
    const rows = await db
      .select({
        id: agentSessions.id,
        messages: agentSessions.messages,
      })
      .from(agentSessions)
      .where(cursor ? gt(agentSessions.id, cursor) : sql`true`)
      .orderBy(asc(agentSessions.id))
      .limit(opts.batchSize);

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    scannedSessions += rows.length;

    for (const row of rows) {
      const messages = Array.isArray(row.messages) ? row.messages : [];
      if (messages.length === 0) continue;

      const [existing] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentSessionTurns)
        .where(eq(agentSessionTurns.agentSessionId, row.id));
      if ((existing?.count ?? 0) > 0) continue;

      const values = messages
        .map((entry, index) => {
          const role = messageRoleToTurnRole(entry);
          if (!role) {
            skippedMalformed += 1;
            return null;
          }
          return {
            agentSessionId: row.id,
            turnIndex: index,
            role,
            content: normalizeTurnContent(entry),
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      if (values.length === 0) continue;

      if (!opts.dryRun) {
        await db.insert(agentSessionTurns).values(values);
      }
      insertedRows += values.length;
      backfilledSessions += 1;
    }

    if (rows.length < opts.batchSize) break;
  }

  // biome-ignore lint/suspicious/noConsole: CLI script
  console.log(
    `[backfill] sessions-scanned=${scannedSessions} sessions-backfilled=${backfilledSessions} ` +
      `rows-inserted=${insertedRows} malformed-skipped=${skippedMalformed}`,
  );
  await closeDb();
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: CLI script
  console.error('[backfill] failed', err);
  process.exit(1);
});
