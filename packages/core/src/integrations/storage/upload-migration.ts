import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

/** Where the uploads are copied to: what the s3 driver (`s3.ts:S3Storage`) offers the migration. */
export interface MigrationTarget {
  put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
  /** Every object under the target's prefix, keyed as `put` was given it, with its size. */
  sizes(): Promise<Map<string, number>>;
}

export interface UploadFile {
  /** The storage key: the path under UPLOADS_DIR, `/`-separated, as the local driver was given it. */
  key: string;
  /** The file on disk. */
  path: string;
}

export interface MigrationReport {
  files: number;
  bytes: number;
}

/** The migration stopped at `file`; nothing after it was copied and none was skipped. */
export class UploadMigrationAborted extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(`upload migration aborted at ${file}: ${reason}`);
    this.name = 'UploadMigrationAborted';
  }
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function walk(root: string, dir: string, out: UploadFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const key = relative(root, path).split(sep).join('/');
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.push({ key, path });
    else throw new UploadMigrationAborted(path, 'it is not a regular file or a directory');
  }
}

/** Every file under `root`, in key order; a missing root or an entry that is no file is refused by name. */
export async function listUploads(root: string): Promise<UploadFile[]> {
  const abs = resolve(root);
  const info = await stat(abs).catch((err: unknown) => {
    throw new UploadMigrationAborted(abs, `UPLOADS_DIR cannot be read: ${reasonOf(err)}`);
  });
  if (!info.isDirectory()) throw new UploadMigrationAborted(abs, 'UPLOADS_DIR is not a directory');
  const out: UploadFile[] = [];
  await walk(abs, abs, out);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Copies every file under `root` to `target` with the same key, reading each back to compare its
 * bytes, then checks the target's listing holds every key at its size: the count and the bytes. The
 * first file that fails aborts the run naming it (ISS-1364); a run is safe to repeat.
 */
export async function migrateUploads(
  root: string,
  target: MigrationTarget,
  log: (line: string) => void = () => {},
): Promise<MigrationReport> {
  const files = await listUploads(root);
  const sizes = new Map<string, number>();
  for (const file of files) {
    let data: Buffer;
    try {
      data = await readFile(file.path);
      const { path } = await target.put(file.key, data, 'application/octet-stream');
      const back = await target.get(path);
      if (!back.equals(data)) {
        throw new Error(
          `read back ${back.length} bytes that differ from the ${data.length} on disk`,
        );
      }
    } catch (err) {
      throw new UploadMigrationAborted(
        file.path,
        `${reasonOf(err)} (${sizes.size} of ${files.length} files copied before it)`,
      );
    }
    sizes.set(file.key, data.length);
    log(`copied ${file.key} (${data.length} bytes)`);
  }

  const listed = await target.sizes();
  for (const file of files) {
    const want = sizes.get(file.key);
    const got = listed.get(file.key);
    if (got !== want) {
      throw new UploadMigrationAborted(
        file.path,
        got === undefined
          ? `the bucket's listing does not hold ${file.key}`
          : `the bucket holds ${got} bytes at ${file.key}, the disk ${want}`,
      );
    }
  }
  let bytes = 0;
  for (const size of sizes.values()) bytes += size;
  return { files: sizes.size, bytes };
}
