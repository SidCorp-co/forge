/**
 * ISS-1030 — rewrite every transcript entry still in the legacy
 * `role`/`contentBlocks` shape into the canonical one, and its inverse.
 *
 * This is a DATA migration and it is written here rather than in SQL for one
 * reason: the conversion has exactly one implementation
 * (`agent-sessions/canonical-legacy.ts`), which the live amnesty on
 * `PATCH /api/agent-sessions/:id` also calls. A plpgsql copy of the same rules
 * would be a second converter, and the two would drift the first time either was
 * corrected — which is the divergence this whole issue exists to end.
 *
 * cm:guard a row the canonical shape cannot represent ABORTS, naming the row.
 * It is not skipped, not dropped and not coerced. A conversation quietly
 * discarded so a deploy could succeed is the failure this repository refuses by
 * name, and the caller (`db/migrate.ts`) exits non-zero on the throw.
 */
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

/**
 * Rows still holding a legacy entry.
 *
 * cm:guard the predicate is a `jsonb` containment test and NOT a `::text LIKE`.
 * `agent_sessions.messages` averages 233 KB and peaks at 35 MB, so casting it to
 * text detoasts every row in the table; `@>` answers from the stored jsonb.
 */
const LEGACY_MESSAGES = `messages @> '[{"role": "user"}]'
   OR messages @> '[{"role": "assistant"}]'
   OR messages @> '[{"role": "tool"}]'
   OR messages @> '[{"role": "system"}]'
   OR messages @> '[{"contentBlocks": []}]'
   OR jsonb_path_exists(messages, '$[*].contentBlocks')
   OR jsonb_path_exists(messages, '$[*].role')`;

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
    await sql`UPDATE agent_sessions SET messages = ${sql.json(converted.messages as never)} WHERE id = ${row.id}`;
    sessions += 1;
    entries += converted.converted;
  }
  return { sessions, entries };
}

/**
 * Convert `agent_session_turns.content.value`.
 *
 * cm:guard the turn table is converted TOO, and it is not an extra: the web
 * formatter reads a turn row's own entry (`parseTurns`), so leaving these in the
 * legacy shape would make every stored user turn render as an agent row the
 * moment `entryRole` loses its `role` branch. The blob and the turn rows are one
 * transcript in two places and a half-converted one is the divergence with a
 * smaller blast radius, not a smaller problem.
 */
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
    await sql`UPDATE agent_session_turns SET content = ${sql.json({ ...(wrapper ?? {}), value: converted.entry } as never)} WHERE id = ${row.id}`;
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

/**
 * The inverse: put every converted entry back as it stood.
 *
 * cm:guard this exists because the forward pass rewrites rows IN PLACE, so
 * restoring the legacy readers does not restore the rows they read. It is a
 * rewrite and not a guess only because `toCanonicalEntry` kept the original
 * under `__legacyEntry`; an entry with no such key was already canonical and is
 * left alone. `The way back` on ISS-1030 names this as the step that runs BEFORE
 * a rolled-back core serves `role`-shaped readers against canonical rows —
 * which is the class of failure ISS-807 was.
 */
/** The name this backfill's completion is recorded under in `backfill_markers`. */
export const CANONICAL_BACKFILL_KEY = 'canonical-transcripts';

/** What one gated attempt did. */
export type BackfillOnce =
  | { ran: false; reason: 'already-done' }
  | { ran: true; report: BackfillReport };

/**
 * Run the canonical backfill unless it has already run to completion.
 *
 * cm:guard the marker is written only when the conversion RETURNS, and that is
 * the whole of what this wrapper is for. Gating on the drizzle ledger instead —
 * the shape this replaced — asks whether the DDL applied, which a boot that
 * applied it and then threw on a row it could not represent answers yes to for
 * ever: the deploy's refusal lasts exactly one attempt, and every boot after it
 * serves canonical-only readers a table still holding legacy rows.
 * cm:edge lockstep -> packages/core/src/db/migrate.ts — its only caller
 */
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
  const sessionRows = await sql<{ id: string; messages: unknown }[]>`
    SELECT id, messages FROM agent_sessions
    WHERE jsonb_path_exists(messages, '$[*].__legacyEntry')
  `;
  let sessions = 0;
  let entries = 0;
  for (const row of sessionRows) {
    if (!Array.isArray(row.messages)) continue;
    const restored = row.messages.map((entry) => legacyEntryOf(entry) ?? entry);
    await sql`UPDATE agent_sessions SET messages = ${sql.json(restored as never)} WHERE id = ${row.id}`;
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
    await sql`UPDATE agent_session_turns SET content = ${sql.json({ ...(wrapper ?? {}), value: legacy } as never)} WHERE id = ${row.id}`;
    turns += 1;
    entries += 1;
  }
  return { sessions, turns, entries };
}
