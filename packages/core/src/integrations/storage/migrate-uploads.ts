/**
 * `pnpm --filter @forge/core storage:migrate-uploads`, or `node dist/integrations/storage/migrate-uploads.js`
 * in the image: copies each file under UPLOADS_DIR that a row still references
 * (`upload-references.ts:UPLOAD_REFERENCE_COLUMNS`) into S3_BUCKET under S3_PREFIX with the same key,
 * verifies count and bytes, and drops every other file, counted and left on disk (ISS-1365). It exits
 * 1 naming the first file that fails, or a row whose file is not on disk. `--list-dropped` also prints
 * each dropped key. It reads the S3_* settings whatever STORAGE_DRIVER says, so it runs before the
 * driver is switched; keep UPLOADS_DIR the same after the switch, since the rows resolve through it.
 */
import { resolve } from 'node:path';
import { closeDb } from '../../db/client.js';
import { env } from '../../lib/env.js';
import { S3Storage, s3SettingsFrom } from './s3.js';
import { migrateUploads, migrationSummary } from './upload-migration.js';
import { uploadReferences } from './upload-references.js';

const FLAGS = ['--list-dropped'];

/** Reads the environment only when run, so importing this file does no work (ISS-1067). */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !FLAGS.includes(a));
  if (unknown.length > 0) {
    console.error(`migrate-uploads takes only ${FLAGS.join(', ')}; it was given ${unknown.join(' ')}`);
    process.exitCode = 1;
    return;
  }
  const root = resolve(env.UPLOADS_DIR);
  try {
    const target = new S3Storage(s3SettingsFrom(env), root);
    const report = await migrateUploads(root, target, await uploadReferences());
    if (args.includes('--list-dropped')) {
      for (const key of report.dropped.keys) console.log(`dropped ${key}`);
    }
    console.log(migrationSummary(report, root, target));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
