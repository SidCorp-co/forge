/**
 * StorageAdapter abstracts where comment attachments (and future uploads) live.
 * Implementations write bytes under a logical `key` and return an opaque
 * `path` string that the caller persists in `comment_attachments.path`. The
 * same path is later passed to `get()` to read the bytes back.
 *
 * The `path` shape is implementation-specific: a filesystem absolute path for
 * `LocalFsStorage`, `s3://bucket/key` for `S3Storage`. Callers must treat it
 * as opaque — only the adapter that produced it can interpret it.
 */
export interface StorageAdapter {
  put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
}

export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
