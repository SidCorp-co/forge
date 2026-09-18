/**
 * ISS-1030 — the way back for the canonical-transcript backfill, as a command.
 *
 * `The way back` on ISS-1030 states that a rollback of this change is
 * compatibility-shaped rather than a revert: the carrier, its route and the
 * contiguous-prefix reader all STAY. What comes back is the `role` branch in the
 * two readers — and the rows those readers read, which the forward pass rewrote
 * in place. This is that step, and it runs BEFORE a rolled-back core serves
 * `role`-shaped readers against canonical rows.
 */
import postgres from 'postgres';
import { revertCanonicalTranscripts } from './backfill-canonical-transcripts.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[revert-canonical] DATABASE_URL not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const report = await revertCanonicalTranscripts(sql);
  console.log(
    `[revert-canonical] ${report.entries} entr(ies) put back across ${report.sessions} session(s) and ${report.turns} turn row(s)`,
  );
} catch (err) {
  console.error('[revert-canonical] failed', err);
  process.exit(1);
} finally {
  await sql.end();
}
