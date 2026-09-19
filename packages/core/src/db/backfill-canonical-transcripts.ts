import type postgres from 'postgres';
import {
  legacyEntryOf,
  toCanonicalEntry,
  toCanonicalMessages,
} from '../agent-sessions/canonical-legacy.js';

/** What one pass rewrote. */
export interface BackfillReport {
  sessions: number;
  turns: number;
  entries: number;
}

type Sql = postgres.Sql<Record<string, never>>;

const LEGACY_MESSAGES = `messages @> '[{"role": "user"}]'
   OR messages @> '[{"role": "assistant"}]'
   OR messages @> '[{"role": "tool"}]'
   OR messages @> '[{"role": "system"}]'
   OR messages @> '[{"contentBlocks": []}]'
   OR jsonb_path_exists(messages, '$[*].contentBlocks')
   OR jsonb_path_exists(messages, '$[*].role')`;

function asJsonb(value: unknown): string {
  return JSON.stringify(value);
}

/** Convert `agent_sessions.messages`, one session at a time. */
async function backfillSessions(sql: Sql): Promise<{ sessions: number; entries: number }> {
  const rows = await sql<{ id: string; messages: unknown }[]>`
    SELECT id, messages FROM agent_sessions
    WHERE messages IS NOT NULL AND (${sql.unsafe(LEGACY_MESSAGES)})
  `;
  let sessions = 0;
  let entries = 0;
  for (const row of rows) {
    const converted = toCanonicalMessages(row.messages);
    if (!converted.ok) {
      throw new Error(
        `backfill-canonical-transcripts: agent_sessions ${row.id} messages[${converted.index}] ${converted.why}. ` +
          'No row was dropped and nothing was coerced — fix or remove that entry and run the deploy again.',
      );
    }
    if (converted.converted === 0) continue;
    await sql`UPDATE agent_sessions SET messages = ${asJsonb(converted.messages)}::jsonb WHERE id = ${row.id}`;
    sessions += 1;
    entries += converted.converted;
  }
  return { sessions, entries };
}

async function backfillTurns(sql: Sql): Promise<{ turns: number; entries: number }> {
  const rows = await sql<{ id: string; content: unknown }[]>`
    SELECT id, content FROM agent_session_turns
    WHERE content @> '{"value": {}}'
      AND (jsonb_path_exists(content, '$.value.role') OR jsonb_path_exists(content, '$.value.contentBlocks'))
  `;
  let turns = 0;
  let entries = 0;
  for (const row of rows) {
    const wrapper = row.content as { value?: unknown } | null;
    const converted = toCanonicalEntry(wrapper?.value);
    if (!converted.ok) {
      throw new Error(
        `backfill-canonical-transcripts: agent_session_turns ${row.id} content.value ${converted.why}. ` +
          'No row was dropped and nothing was coerced — fix or remove that turn and run the deploy again.',
      );
    }
    if (!converted.converted) continue;
    await sql`UPDATE agent_session_turns SET content = ${asJsonb({ ...(wrapper ?? {}), value: converted.entry })}::jsonb WHERE id = ${row.id}`;
    turns += 1;
    entries += 1;
  }
  return { turns, entries };
}

export async function backfillCanonicalTranscripts(sql: Sql): Promise<BackfillReport> {
  const s = await backfillSessions(sql);
  const t = await backfillTurns(sql);
  return { sessions: s.sessions, turns: t.turns, entries: s.entries + t.entries };
}

/** The name this backfill's completion is recorded under in `backfill_markers`. */
export const CANONICAL_BACKFILL_KEY = 'canonical-transcripts';

/** What one gated attempt did. */
export type BackfillOnce =
  | { ran: false; reason: 'already-done' }
  | { ran: true; report: BackfillReport };

export async function runCanonicalBackfillOnce(sql: Sql): Promise<BackfillOnce> {
  const marked = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM backfill_markers WHERE key = ${CANONICAL_BACKFILL_KEY}
  `;
  if ((marked[0]?.n ?? 0) > 0) return { ran: false, reason: 'already-done' };
  const report = await backfillCanonicalTranscripts(sql);
  await sql`
    INSERT INTO backfill_markers (key) VALUES (${CANONICAL_BACKFILL_KEY})
    ON CONFLICT (key) DO NOTHING
  `;
  return { ran: true, report };
}

export async function revertCanonicalTranscripts(sql: Sql): Promise<BackfillReport> {
  await sql`DELETE FROM backfill_markers WHERE key = ${CANONICAL_BACKFILL_KEY}`;
  const sessionRows = await sql<{ id: string; messages: unknown }[]>`
    SELECT id, messages FROM agent_sessions
    WHERE jsonb_path_exists(messages, '$[*].__legacyEntry')
  `;
  let sessions = 0;
  let entries = 0;
  for (const row of sessionRows) {
    if (!Array.isArray(row.messages)) continue;
    const restored = row.messages.map((entry) => legacyEntryOf(entry) ?? entry);
    await sql`UPDATE agent_sessions SET messages = ${asJsonb(restored)}::jsonb WHERE id = ${row.id}`;
    sessions += 1;
    entries += row.messages.filter((e) => legacyEntryOf(e) !== null).length;
  }

  const turnRows = await sql<{ id: string; content: unknown }[]>`
    SELECT id, content FROM agent_session_turns
    WHERE jsonb_path_exists(content, '$.value.__legacyEntry')
  `;
  let turns = 0;
  for (const row of turnRows) {
    const wrapper = row.content as { value?: unknown } | null;
    const legacy = legacyEntryOf(wrapper?.value);
    if (legacy === null) continue;
    await sql`UPDATE agent_session_turns SET content = ${asJsonb({ ...(wrapper ?? {}), value: legacy })}::jsonb WHERE id = ${row.id}`;
    turns += 1;
    entries += 1;
  }
  return { sessions, turns, entries };
}
