import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { runCriteriaBackfillOnce } from '../issues/criteria/backfill.js';
import { initSentry, Sentry } from '../observability/sentry.js';
import { runCanonicalBackfillOnce } from './backfill-canonical-transcripts.js';
import { closeDb } from './client.js';
import {
  describeUnrecorded,
  type JournalEntry,
  partitionUnrecorded,
  unrecordedSentryEvent,
} from './migration-audit.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL not set');
  process.exit(1);
}

const migrationsFolder = new URL('../../drizzle/migrations', import.meta.url).pathname;
const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

try {
  console.log('[migrate] applying migrations from', migrationsFolder);
  await migrate(db, { migrationsFolder });

  const backfill = await runCanonicalBackfillOnce(sql);
  if (backfill.ran) {
    const { entries, sessions, turns } = backfill.report;
    console.log(
      `[migrate] canonical-transcript backfill: ${entries} entr(ies) rewritten across ${sessions} session(s) and ${turns} turn row(s)`,
    );
  }

  const criteria = await runCriteriaBackfillOnce();
  if (criteria) {
    for (const line of criteria.refusals)
      console.warn(`[migrate] criteria backfill refused: ${line}`);
    console.log(
      `[migrate] criteria backfill: ${criteria.criteria} criteria on ${criteria.issues} issue(s), ${criteria.verdicts} verdict(s) (${criteria.commitUnresolved} commit_unresolved), ${criteria.refusals.length} refused by name`,
    );
  }

  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
    entries: JournalEntry[];
  };
  const recorded = await sql<{ created_at: string }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations
  `;
  const { investigated, unexpected } = partitionUnrecorded(
    journal.entries,
    recorded.map((r) => Number(r.created_at)),
  );
  if (investigated.length > 0) {
    console.log(
      `[migrate] ${investigated.length} known-unrecorded migration(s), schema verified, not alarmed: ${investigated.map((m) => m.tag).join(', ')}`,
    );
  }
  const unrecorded = unexpected;
  if (unrecorded.length > 0) {
    console.warn(describeUnrecorded(unrecorded));
    try {
      if (initSentry()) {
        const event = unrecordedSentryEvent(unrecorded);
        Sentry.captureMessage(event.message, {
          level: event.level,
          tags: event.tags,
          extra: event.extra,
        });
        await Sentry.flush(2000); // migrate.js exits right after — flush now or the event is dropped
      }
    } catch (sentryErr) {
      console.warn('[migrate] failed to report unrecorded-migration drift to Sentry', sentryErr);
    }
  }

  console.log(
    `[migrate] done — journal ${journal.entries.length}, recorded ${recorded.length}, known-unrecorded ${investigated.length}, unexpected ${unrecorded.length}`,
  );
} catch (err) {
  console.error('[migrate] failed', err);
  process.exit(1);
} finally {
  await sql.end();
  await closeDb();
}
