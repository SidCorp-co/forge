/** One `meta/_journal.json` entry, narrowed to what the audit needs. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export const INVESTIGATED_UNRECORDED: ReadonlySet<string> = new Set([
  '0041_pm_agent',
  '0062_personal_access_tokens',
  '0063_mcp_audit_log',
]);

export function partitionUnrecorded(
  journal: JournalEntry[],
  recordedCreatedAt: Iterable<number>,
): { investigated: JournalEntry[]; unexpected: JournalEntry[] } {
  const unrecorded = findUnrecordedMigrations(journal, recordedCreatedAt);
  return {
    investigated: unrecorded.filter((e) => INVESTIGATED_UNRECORDED.has(e.tag)),
    unexpected: unrecorded.filter((e) => !INVESTIGATED_UNRECORDED.has(e.tag)),
  };
}

export function findUnrecordedMigrations(
  journal: JournalEntry[],
  recordedCreatedAt: Iterable<number>,
): JournalEntry[] {
  const recorded = new Set<number>();
  for (const v of recordedCreatedAt) recorded.add(Number(v));
  return journal.filter((e) => !recorded.has(Number(e.when))).sort((a, b) => a.idx - b.idx);
}

/** Operator-facing warning text: what is unrecorded, and what that does and does not imply. */
export function describeUnrecorded(missing: JournalEntry[]): string {
  const lines = missing.map((m) => `  - ${m.tag} (idx ${m.idx}, when ${m.when})`);
  return [
    `[migrate] WARNING: ${missing.length} journal migration(s) have no row in drizzle.__drizzle_migrations:`,
    ...lines,
    '[migrate] This does NOT prove their DDL is missing — check the schema before re-running one.',
    '[migrate] It DOES mean the migrator will never touch them again: it only applies entries',
    '[migrate] whose `when` exceeds the highest recorded created_at, and reports success when it skips.',
  ].join('\n');
}

/**
 * Sentry event payload for unrecorded-migration drift — pure, so it unit-tests without mocking
 * the SDK. `migrate.js` boots as its own short-lived process where nobody reads stdout; this is
 * what makes the drift visible without tailing container logs.
 */
export function unrecordedSentryEvent(missing: JournalEntry[]): {
  message: string;
  level: 'warning';
  tags: Record<string, string>;
  extra: Record<string, unknown>;
} {
  return {
    message: `db.migrate: ${missing.length} unrecorded migration(s) in drizzle.__drizzle_migrations`,
    level: 'warning',
    tags: { area: 'db-migrate', issue: 'ISS-809' },
    extra: {
      count: missing.length,
      entries: missing.map((m) => ({ tag: m.tag, idx: m.idx, when: m.when })),
      note: 'Unrecorded != unapplied — check schema before re-running. Migrator will never re-touch these.',
    },
  };
}
