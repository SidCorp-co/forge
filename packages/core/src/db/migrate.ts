import { readFileSync } from 'node:fs';
import { OUTBOX_EVENT_TYPES } from '@forge/contracts/outbox-events';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { flushReports, isErrorTrackingEnabled, reportCondition } from '../lib/error-tracking.js';
import { RefusalError } from '../lib/refusal.js';
import {
  describeUnrecorded,
  type JournalEntry,
  partitionUnrecorded,
  unrecordedSentryEvent,
} from './migration-audit.js';

export const SHIPPED_MIGRATIONS_FOLDER = new URL('../../drizzle/migrations', import.meta.url)
  .pathname;

/**
 * How long one migration statement waits for a lock another session holds before the boot fails by
 * name. Without it the wait is unbounded: the boot neither serves nor exits, and nothing is logged.
 */
export const MIGRATE_LOCK_TIMEOUT_MS = 60_000;

/** How long a failure report gets to leave before the process exits 1. */
const REPORT_FLUSH_MS = 5_000;

/** Where the boot was when it stopped: `reading-recorded` is the first query, so a refused connect lands there. */
export type MigrateStage =
  | 'environment'
  | 'reading-recorded'
  | 'applying'
  | 'auditing'
  | 'checking-event-types';

export interface MigrateFailure {
  stage: MigrateStage;
  /** The migration whose statement failed, when the failure names one. */
  migration: string | null;
  /** Journal entries the migrator was about to apply, in order. */
  pending: string[];
  journal: number;
  /** Rows in drizzle.__drizzle_migrations before applying; null when they were never read. */
  recorded: number | null;
  error: string;
  /** The Postgres SQLSTATE, or the driver's code for a connection failure. */
  code: string | null;
}

interface MigrateOptions {
  migrationsFolder?: string;
  lockTimeoutMs?: number;
}

function readJournal(folder: string): JournalEntry[] {
  return (
    JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] }
  ).entries;
}

/** The entries drizzle's migrator applies: every one whose `when` exceeds the highest recorded. */
export function pendingMigrations(journal: JournalEntry[], recorded: number[]): JournalEntry[] {
  const highest = recorded.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...recorded);
  return journal.filter((e) => Number(e.when) > highest);
}

/**
 * The migration a failed statement belongs to: drizzle's query error carries the statement text,
 * which is one `--> statement-breakpoint` chunk of exactly one migration file. Null when the error
 * names no statement, or one no pending file holds (the migrator's own bookkeeping insert).
 */
export function migrationOfFailure(
  err: unknown,
  pending: JournalEntry[],
  folder: string,
): string | null {
  const statement = (err as { query?: unknown } | null)?.query;
  if (typeof statement !== 'string' || pending.length === 0) return null;
  const tagByWhen = new Map(pending.map((e) => [Number(e.when), e.tag]));
  for (const file of readMigrationFiles({ migrationsFolder: folder })) {
    const tag = tagByWhen.get(Number(file.folderMillis));
    if (tag !== undefined && file.sql.includes(statement)) return tag;
  }
  return null;
}

function codeOf(err: unknown): string | null {
  for (
    let e = err as { code?: unknown; cause?: unknown } | null, depth = 0;
    e && depth < 4;
    depth++
  ) {
    if (typeof e.code === 'string') return e.code;
    e = e.cause as typeof e;
  }
  return null;
}

/** The driver's own message (drizzle's wrapper repeats the whole statement), cut to a line. */
function messageOf(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  const root = cause instanceof Error ? cause : err;
  const text = root instanceof Error ? root.message : String(root);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** The failure report — pure, so its shape unit-tests without a tracker. */
export function migrateFailureEvent(failure: MigrateFailure): {
  message: string;
  level: 'fatal';
  tags: Record<string, string>;
  extra: Record<string, unknown>;
} {
  const where = failure.migration ? ` at ${failure.migration}` : '';
  return {
    message: `db.migrate: boot migration failed while ${failure.stage}${where}: ${failure.error}`,
    level: 'fatal',
    tags: {
      area: 'db-migrate',
      stage: failure.stage,
      ...(failure.migration ? { migration: failure.migration } : {}),
      ...(failure.code ? { code: failure.code } : {}),
    },
    extra: {
      migration: failure.migration,
      pending: failure.pending,
      journal: failure.journal,
      recorded: failure.recorded,
      error: failure.error,
      code: failure.code,
    },
  };
}

async function reportMigrateFailure(failure: MigrateFailure): Promise<void> {
  const event = migrateFailureEvent(failure);
  console.error(`[migrate] ${event.message}`);
  console.error(
    `[migrate] journal ${failure.journal}, recorded ${failure.recorded ?? 'unread'}, pending ${failure.pending.length}${failure.pending.length > 0 ? ` (${failure.pending.join(', ')})` : ''}`,
  );
  reportCondition(event.message, { level: event.level, tags: event.tags, extra: event.extra });
  try {
    await flushReports(REPORT_FLUSH_MS); // the process exits right after — flush now or the event is dropped
  } catch (flushErr) {
    console.error('[migrate] the failure report could not be flushed', flushErr);
  }
}

async function reportDrift(unrecorded: JournalEntry[]): Promise<void> {
  console.warn(describeUnrecorded(unrecorded));
  try {
    if (isErrorTrackingEnabled()) {
      const event = unrecordedSentryEvent(unrecorded);
      reportCondition(event.message, { level: event.level, tags: event.tags, extra: event.extra });
      await flushReports(2000);
    }
  } catch (sentryErr) {
    console.warn('[migrate] failed to report unrecorded-migration drift to Sentry', sentryErr);
  }
}

/** The registry's event types `outbox_event_types` lacks: an emit of any of them would fail the
 *  outbox's foreign key, so the boot refuses before the app serves one. */
export function outboxTypesUnseeded(seeded: readonly string[]): string[] {
  const held = new Set(seeded);
  return OUTBOX_EVENT_TYPES.filter((t) => !held.has(t));
}

/**
 * The boot's migration step: applies every pending migration, audits the record, and answers the
 * process exit code. A failure at any stage is logged AND reported through the error-tracking port,
 * flushed before this returns 1 — the migrate process is short-lived and nobody reads its stdout.
 */
export async function migrateAtBoot(
  databaseUrl: string | undefined,
  {
    migrationsFolder = SHIPPED_MIGRATIONS_FOLDER,
    lockTimeoutMs = MIGRATE_LOCK_TIMEOUT_MS,
  }: MigrateOptions = {},
): Promise<0 | 1> {
  let stage: MigrateStage = 'environment';
  let journal: JournalEntry[] = [];
  let recorded: number[] | null = null;
  let pending: JournalEntry[] = [];
  let sql: postgres.Sql | null = null;
  try {
    if (!databaseUrl) throw new Error('DATABASE_URL is not set');
    journal = readJournal(migrationsFolder);
    sql = postgres(databaseUrl, {
      max: 1,
      onnotice: (notice) => console.log(`[migrate] notice: ${notice.message}`),
      connection: { lock_timeout: lockTimeoutMs },
    });

    stage = 'reading-recorded';
    const [table] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
    `;
    const before = table?.exists
      ? await sql<{ created_at: string }[]>`SELECT created_at FROM drizzle.__drizzle_migrations`
      : [];
    recorded = before.map((r) => Number(r.created_at));
    pending = pendingMigrations(journal, recorded);
    console.log(
      `[migrate] applying ${pending.length} pending of ${journal.length} from ${migrationsFolder}${pending.length > 0 ? `: ${pending.map((e) => e.tag).join(', ')}` : ''}`,
    );

    stage = 'applying';
    await migrate(drizzle(sql), { migrationsFolder });

    stage = 'auditing';
    const after = await sql<{ created_at: string }[]>`
      SELECT created_at FROM drizzle.__drizzle_migrations
    `;
    const { investigated, unexpected } = partitionUnrecorded(
      journal,
      after.map((r) => Number(r.created_at)),
    );
    if (investigated.length > 0) {
      console.log(
        `[migrate] ${investigated.length} known-unrecorded migration(s), schema verified, not alarmed: ${investigated.map((m) => m.tag).join(', ')}`,
      );
    }
    if (unexpected.length > 0) await reportDrift(unexpected);

    stage = 'checking-event-types';
    const seeded = await sql<{ type: string }[]>`SELECT type FROM outbox_event_types`;
    const unseeded = outboxTypesUnseeded(seeded.map((r) => r.type));
    if (unseeded.length > 0) {
      throw new RefusalError(
        [
          {
            code: 'OUTBOX_TYPE_UNSEEDED',
            path: '',
            detail: `outbox_event_types holds no row for ${unseeded.join(', ')}, which OUTBOX_EVENT_TYPES emits, so every such emit would fail its foreign key. Add a migration inserting each (INSERT INTO "outbox_event_types" ("type") VALUES ('<type>')), then deploy again.`,
          },
        ],
        'OUTBOX_TYPE_UNSEEDED',
      );
    }

    console.log(
      `[migrate] done — journal ${journal.length}, recorded ${after.length}, known-unrecorded ${investigated.length}, unexpected ${unexpected.length}`,
    );
    return 0;
  } catch (err) {
    await reportMigrateFailure({
      stage,
      migration: stage === 'applying' ? migrationOfFailure(err, pending, migrationsFolder) : null,
      pending: pending.map((e) => e.tag),
      journal: journal.length,
      recorded: recorded?.length ?? null,
      error: messageOf(err),
      code: codeOf(err),
    });
    return 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}
