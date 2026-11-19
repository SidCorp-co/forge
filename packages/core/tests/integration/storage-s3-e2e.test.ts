/**
 * ISS-1364: uploads in an S3-compatible bucket, every key under S3_PREFIX. A throwaway MinIO, booted
 * before this file's process loads core, so the whole app here runs with STORAGE_DRIVER=s3.
 *
 * It runs `docker` and the migration command as processes of its own, which the whole-tree guard
 * cannot read, so it declares itself as the install tests do.
 * @gate-input whole-tree
 * @direct-test-of packages/core/src/integrations/storage/migrate-uploads.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { getStorage } from '../../src/integrations/storage/factory.js';
import { LocalFsStorage } from '../../src/integrations/storage/local-fs.js';
import { S3Storage } from '../../src/integrations/storage/s3.js';
import { migrateUploads } from '../../src/integrations/storage/upload-migration.js';
import { env } from '../../src/lib/env.js';
import { startMinio, stopMinio } from '../helpers/minio-container.js';

const BUCKET = 'forge-it-shared';
const PREFIX = 'forge-it/';
const minio = await startMinio([BUCKET]);
afterAll(() => stopMinio(minio.name));

const S3_ENV = {
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: minio.endpoint,
  S3_REGION: 'us-east-1',
  S3_BUCKET: BUCKET,
  S3_PREFIX: PREFIX,
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: minio.accessKeyId,
  S3_SECRET_ACCESS_KEY: minio.secretAccessKey,
};
Object.assign(process.env, S3_ENV);

const CORE = fileURLToPath(new URL('../..', import.meta.url));
const TSX = createRequire(import.meta.url).resolve('tsx/cli');

async function objectSize(key: string): Promise<number | null> {
  try {
    const head = await minio.client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

describe('STORAGE_DRIVER=s3: getStorage() stores under S3_PREFIX (ISS-1364 criterion 1)', () => {
  it('puts, gets and deletes through the s3 adapter, every key under the prefix', async () => {
    const storage = getStorage();
    expect(storage).toBeInstanceOf(S3Storage);
    await minio.client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'agenfold-dev/keep.txt', Body: 'neighbour' }),
    );

    const bytes = Buffer.from('an attachment');
    const { path } = await storage.put('iss1364/a.txt', bytes, 'text/plain');
    expect(path).toBe(`s3://${BUCKET}/${PREFIX}iss1364/a.txt`);
    expect(await objectSize(`${PREFIX}iss1364/a.txt`)).toBe(bytes.length);
    expect(await objectSize('iss1364/a.txt')).toBeNull();
    expect((await storage.get(path)).equals(bytes)).toBe(true);

    await storage.delete(path);
    await expect(storage.get(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(storage.delete(path)).resolves.toBeUndefined();
    expect(await objectSize('agenfold-dev/keep.txt')).toBe('neighbour'.length);
  });
});

describe('the upload migration (ISS-1364 criterion 3)', () => {
  it('copies a local-driver tree to the same keys, so the rows it wrote keep resolving', async () => {
    const local = new LocalFsStorage(env.UPLOADS_DIR);
    const rows = [
      await local.put('issues/i1/shot.png', Buffer.alloc(2048, 7), 'image/png'),
      await local.put('feedback/f1/note.txt', Buffer.from('kept'), 'text/plain'),
    ];
    const s3 = getStorage() as S3Storage;
    const report = await migrateUploads(env.UPLOADS_DIR, s3);
    expect(report).toEqual({ files: 2, bytes: 2052 });
    expect(await objectSize(`${PREFIX}issues/i1/shot.png`)).toBe(2048);
    for (const row of rows) {
      expect((await s3.get(row.path)).equals(await local.get(row.path))).toBe(true);
    }
  });

  it('runs as a command: exit 0 with count and bytes, exit 1 naming the first file that fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iss1364-cli-'));
    try {
      mkdirSync(join(dir, 'm/1'), { recursive: true });
      writeFileSync(join(dir, 'm/1/a.bin'), Buffer.alloc(10, 1));
      writeFileSync(join(dir, 'm/1/b.bin'), Buffer.alloc(5, 2));
      const run = (over: Record<string, string>) =>
        spawnSync(process.execPath, [TSX, 'src/integrations/storage/migrate-uploads.ts'], {
          cwd: CORE,
          encoding: 'utf8',
          env: { ...process.env, ...S3_ENV, STORAGE_DRIVER: 'local', UPLOADS_DIR: dir, ...over },
        });

      const ok = run({});
      expect(ok.stderr).toBe('');
      expect(ok.stdout).toContain(
        `migrated 2 files, 15 bytes, from ${dir} to s3://${BUCKET}/${PREFIX}: count and bytes verified`,
      );
      expect(ok.status).toBe(0);

      const absent = run({ S3_BUCKET: 'forge-it-absent' });
      expect(absent.status).toBe(1);
      expect(absent.stderr).toContain(`upload migration aborted at ${join(dir, 'm/1/a.bin')}:`);
      expect(absent.stderr).toContain('(0 of 2 files copied before it)');

      const unset = run({ S3_PREFIX: '' });
      expect(unset.status).toBe(1);
      expect(unset.stderr).toContain('the s3 storage driver needs S3_PREFIX, which are unset');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
