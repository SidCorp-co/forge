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
 * The unrecorded entries already investigated, by tag. Each was confirmed on
 * forge-beta 2026-08-19 by querying for the objects it creates:
 * `0041_pm_agent` → issue_dependencies, pm_decisions, pm_config, pm_policies;
 * `0062_personal_access_tokens` → personal_access_tokens;
 * `0063_mcp_audit_log` → mcp_audit_log. All present.
 */
// cm:guard baseline the measured three so a FOURTH is visible — before this, every boot warned and raised the same Sentry event forever, and new drift would have surfaced only as the count going 3 → 4 inside noise nobody reads
// cm:edge lockstep -> packages/core/src/db/migrate.ts — removing a tag here re-arms its warning; the two files are one mechanism
export const INVESTIGATED_UNRECORDED: ReadonlySet<string> = new Set([
  '0041_pm_agent',
  '0062_personal_access_tokens',
  '0063_mcp_audit_log',
]);

/**
 * Split the unrecorded entries into the ones already investigated and the ones
 * that are new. Only `unexpected` deserves an alarm: an entry in the baseline
 * has had its schema checked by a human, and re-raising it on every container
 * start is what makes the alarm worthless when it finally means something.
 */
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
