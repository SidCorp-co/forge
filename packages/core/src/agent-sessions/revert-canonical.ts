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
