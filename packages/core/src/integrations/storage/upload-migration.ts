import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Where the uploads are copied to: what the s3 driver (`s3.ts:S3Storage`) offers the migration. */
export interface MigrationTarget {
  put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
  /** Every object under the target's prefix, keyed as `put` was given it, with its size. */
  sizes(): Promise<Map<string, number>>;
  /** The prefix every path `put` answers starts with: `s3://<bucket>/<prefix>`. */
  describe(): string;
}

export interface UploadFile {
  /** The storage key: the path under UPLOADS_DIR, `/`-separated, as the local driver was given it. */
  key: string;
  /** The file on disk. */
  path: string;
}

/** One stored path a row holds (`upload-references.ts:uploadReferences`), named for a refusal. */
export interface StoredReference {
  /** `table.column`, as `UPLOAD_REFERENCE_COLUMNS` names it. */
  column: string;
  id: string;
  path: string;
}

export interface MigrationReport {
  /** The files a row references, copied and verified. */
  migrated: { files: number; bytes: number };
  /** The files no row references: not copied, left on disk (ISS-1082 removes the volume). */
  dropped: { files: number; bytes: number; keys: string[] };
  /** Stored paths checked against the bucket's listing after the copy: every row's. */
  resolved: number;
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

/** The key a row's path resolves to, on the disk (`local`) or already in the bucket (`bucket`). */
function keyOf(
  ref: StoredReference,
  root: string,
  bucketPrefix: string,
): { where: 'local' | 'bucket'; key: string } {
  if (ref.path.startsWith(bucketPrefix)) {
    return { where: 'bucket', key: ref.path.slice(bucketPrefix.length) };
  }
  const rel = isAbsolute(ref.path) ? relative(root, ref.path) : '..';
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UploadMigrationAborted(
      ref.path,
      `${ref.column} of row ${ref.id} is neither a file under UPLOADS_DIR ${root} nor a path under ${bucketPrefix}`,
    );
  }
  return { where: 'local', key: rel.split(sep).join('/') };
}

/**
 * Copies to `target`, under the same key, each file under `root` that a row in `references` holds,
 * reading each back to compare its bytes, then checks the target's listing holds every key a row
 * holds at its size. Every other file is dropped: not copied, left on disk, counted (ISS-1365, owner
 * 2026-11-21: migrate only the files still needed). A row whose file is not on disk is refused before
 * anything is copied; the first file that fails aborts the run naming it. A run is safe to repeat.
 */
export async function migrateUploads(
  root: string,
  target: MigrationTarget,
  references: StoredReference[],
): Promise<MigrationReport> {
  const abs = resolve(root);
  const files = await listUploads(abs);
  const onDisk = new Map(files.map((f) => [f.key, f]));
  const needed = new Set<string>();
  const inBucket: { ref: StoredReference; key: string }[] = [];
  for (const ref of references) {
    const { where, key } = keyOf(ref, abs, target.describe());
    if (where === 'bucket') {
      inBucket.push({ ref, key });
    } else if (onDisk.has(key)) {
      needed.add(key);
    } else {
      throw new UploadMigrationAborted(
        ref.path,
        `${ref.column} of row ${ref.id} references ${key}, which has no file under UPLOADS_DIR ${abs}`,
      );
    }
  }

  const sizes = new Map<string, number>();
  const toCopy = files.filter((f) => needed.has(f.key));
  for (const file of toCopy) {
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
        `${reasonOf(err)} (${sizes.size} of ${toCopy.length} files copied before it)`,
      );
    }
    sizes.set(file.key, data.length);
  }

  const listed = await target.sizes();
  for (const file of toCopy) {
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
  for (const { ref, key } of inBucket) {
    if (!listed.has(key)) {
      throw new UploadMigrationAborted(
        ref.path,
        `${ref.column} of row ${ref.id}: the bucket's listing does not hold ${key}`,
      );
    }
  }

  const dropped = files.filter((f) => !needed.has(f.key));
  let droppedBytes = 0;
  for (const file of dropped) droppedBytes += (await stat(file.path)).size;
  let bytes = 0;
  for (const size of sizes.values()) bytes += size;
  return {
    migrated: { files: sizes.size, bytes },
    dropped: { files: dropped.length, bytes: droppedBytes, keys: dropped.map((f) => f.key) },
    resolved: references.length,
  };
}

/** The one line a run prints (`migrate-uploads.ts`), which the record quotes. */
export function migrationSummary(
  report: MigrationReport,
  root: string,
  target: Pick<MigrationTarget, 'describe'>,
): string {
  const { migrated: m, dropped: d } = report;
  return (
    `migrated ${m.files} files, ${m.bytes} bytes, and dropped ${d.files} files, ${d.bytes} bytes (unreferenced), ` +
    `from ${resolve(root)} to ${target.describe()}: count and bytes verified, and all ${report.resolved} stored paths resolve in the bucket`
  );
}
