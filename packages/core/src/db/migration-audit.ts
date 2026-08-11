// Reports, after the migrator returns, which migrations the code ships with have
// no row in drizzle's bookkeeping table (ISS-809).
//
// NAMING IS THE POINT: this detects UNRECORDED, not unapplied. Measured on
// forge-beta 2026-08-11, three entries have no row while every table they create
// exists — the DDL ran, the ledger did not record it. Treating "unrecorded" as
// "unapplied" is what would make this dangerous: a hard gate on it refuses to
// start a container whose schema is perfectly correct.
//
// drizzle compares each migration's `when` against ONLY the highest recorded
// `created_at` (pg-core/dialect.js), skipping anything at or below in silence —
// so `migrate()` can return success having applied nothing. That is how ISS-807
// put a live 500 on /me/attention. The authored-wrong case is caught before
// merge by migrations-journal.test.ts; this makes the rest visible at deploy.

/** One `meta/_journal.json` entry, narrowed to what the audit needs. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Journal entries with no matching `created_at` row. This means the ledger has
 * no record of them — NOT that their DDL is absent. Verify the schema itself
 * before concluding a migration needs re-running.
 *
 * Compared on `when` rather than on the SQL hash deliberately: `created_at` IS
 * the journal's `when` (dialect.js inserts `migration.folderMillis`), so this
 * asks the one question that matters — did this entry run — without depending
 * on how drizzle happens to hash file contents in a given version.
 */
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
