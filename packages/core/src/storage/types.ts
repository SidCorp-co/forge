export interface StorageAdapter {
  put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
}

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
