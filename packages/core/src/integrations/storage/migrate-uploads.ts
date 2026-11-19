/**
 * `pnpm --filter @forge/core storage:migrate-uploads`, or `node dist/integrations/storage/migrate-uploads.js`
 * in the image: copies every file under UPLOADS_DIR into S3_BUCKET under S3_PREFIX with the same
 * keys, verifies count and bytes, and exits 1 naming the first file that fails (ISS-1364). It reads
 * the S3_* settings whatever STORAGE_DRIVER says, so it runs before the driver is switched; keep
 * UPLOADS_DIR the same after the switch, since the rows it leaves resolve through it.
 */
import { resolve } from 'node:path';
import { env } from '../../lib/env.js';
import { S3Storage, s3SettingsFrom } from './s3.js';
import { migrateUploads } from './upload-migration.js';

const root = resolve(env.UPLOADS_DIR);
try {
  const target = new S3Storage(s3SettingsFrom(env), root);
  const report = await migrateUploads(root, target, (line) => console.log(line));
  console.log(
    `migrated ${report.files} files, ${report.bytes} bytes, from ${root} to ${target.describe()}: count and bytes verified`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
