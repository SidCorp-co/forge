// REQ-89 BC-5 (ISS-1156): a temporary entry names what ends it (`curation.endsWhen`), and core retires
// it when it sees that happen:
//  - an issue key, on a note: the issue reaching closed or dropped (note-lifetime.ts);
//  - a path, route, config key or rule slug, read as `recheckWhen`'s anchors are (knowledge/recheck.ts):
//    a landing whose commit touched the path or whose words name the route or key, or a rewrite of the
//    rule (recheck.ts flagMemoriesForChange). The entry is archived, its reason on `metadata.archivedBy`.
// Core sees nothing else that ends an entry: a plugin version shipping, a person's decision, a config
// value changed outside a landing. A write naming only such an ending is warned, and the sweep flags
// the entry for re-check once the project's note window passes with no check; decay then retires a
// flag left unconfirmed (decay.ts STALE_UNCONFIRMED_DAYS).

import type { CurationWarning } from '@forge/contracts/knowledge';
import { MEMORY_AUTHORED_SOURCES } from '@forge/contracts/memory';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memories } from '../db/schema.js';
import { sqlTimestamp } from '../db/sql-timestamp.js';
import { type Anchors, anchorsOf } from '../knowledge/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** An issue key as an ending names it (`ISS-12`, `forge ISS-12`). */
export const ENDING_ISSUE_KEY = /\b([A-Z][A-Z0-9]{0,15}-[1-9]\d{0,8})\b/;

/** The paths, routes, config keys and rule slugs an ending names; null where it names none. */
export function endingAnchors(endsWhen: string | null | undefined): Anchors | null {
  if (!endsWhen) return null;
  const a = anchorsOf(endsWhen);
  return a.paths.length + a.routes.length + a.config.length + a.rules.length > 0 ? a : null;
}

/** Whether core can see the ending happen: an issue key on a note, or an anchor a change can meet. */
export function endingObserved(source: string, endsWhen: string): boolean {
  if (source === 'note' && ENDING_ISSUE_KEY.test(endsWhen)) return true;
  return endingAnchors(endsWhen) !== null;
}

/** The `metadata.archivedBy` of an entry whose ending a change met. */
export const endedByChange = (by: string, matched: readonly string[]) =>
  `ended: ${by} changed ${matched.join(', ')}, which its endsWhen names`;

/** The `staleReason` of an entry whose ending core cannot see, flagged once its window passed unchecked. */
export const endingUnobserved = (endsWhen: string, days: number) =>
  `ends when "${endsWhen.slice(0, 200)}", which core cannot observe, and nobody checked it in ${days} days: confirm it still holds, rewrite it, or retire it`;

/** The write's warning for an ending core cannot see: the entry is re-checked, never retired by it. */
export function unobservedEndingWarning(
  source: string,
  endsWhen: string | undefined,
): CurationWarning[] {
  if (!endsWhen || !(MEMORY_AUTHORED_SOURCES as readonly string[]).includes(source)) return [];
  if (endingObserved(source, endsWhen)) return [];
  return [
    {
      code: 'ENDING_UNOBSERVED',
      path: '/endsWhen',
      detail:
        `\`endsWhen\` names nothing core can see happen (${source === 'note' ? 'an issue key, ' : ''}a path, a route under /api/, a backticked config key such as \`memory.noteWindowDays\` or a backticked rule slug), ` +
        'so it is never retired by it: it is flagged for a re-check once the note window passes unchecked. A plugin version or a person deciding is such an ending.',
    },
  ];
}

/**
 * Flag every live curated entry whose ending core cannot observe, unchecked since its last write for
 * longer than its project's note window and not flagged already; how many were. `windowOf` reads a
 * project's window (note-lifetime.ts noteWindowDays).
 */
export async function flagUnobservedEndings(
  now: number,
  windowOf: (projectId: string) => Promise<number>,
): Promise<number> {
  const rows = await db
    .select({
      id: memories.id,
      projectId: memories.projectId,
      source: memories.source,
      endsWhen: sql<string>`${memories.metadata}->'curation'->>'endsWhen'`,
      lastTouched: sql<Date>`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.updatedAt}))`,
    })
    .from(memories)
    .where(
      and(
        isNull(memories.archivedAt),
        inArray(memories.source, [...MEMORY_AUTHORED_SOURCES]),
        sql`coalesce(${memories.metadata}->'curation'->>'endsWhen', '') <> ''`,
        sql`${memories.metadata}->>'staleSince' IS NULL`,
        sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastVerifiedAt}, ${memories.updatedAt})) < ${sqlTimestamp(new Date(now - DAY_MS))}`,
      ),
    );
  const windows = new Map<string, number>();
  let flagged = 0;
  for (const row of rows) {
    if (endingObserved(row.source, row.endsWhen)) continue;
    const days = windows.get(row.projectId) ?? (await windowOf(row.projectId));
    windows.set(row.projectId, days);
    if (new Date(row.lastTouched).getTime() >= now - days * DAY_MS) continue;
    const flag = {
      staleSince: new Date(now).toISOString(),
      staleReason: endingUnobserved(row.endsWhen, days),
    };
    await db
      .update(memories)
      .set({ metadata: sql`${memories.metadata} || ${JSON.stringify(flag)}::jsonb` })
      .where(eq(memories.id, row.id));
    flagged++;
  }
  return flagged;
}
