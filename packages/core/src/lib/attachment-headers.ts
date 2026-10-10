import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

const INERT_MIMES = new Set(['image/svg+xml', 'text/html']);

export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function setInertAttachmentHeaders(
  c: Context,
  mime: string,
  name: string,
  download = false,
): void {
  c.header('Content-Type', mime);
  c.header('X-Content-Type-Options', 'nosniff');
  const inert = INERT_MIMES.has(mime);
  c.header(
    'Content-Disposition',
    contentDisposition(inert || download ? 'attachment' : 'inline', name),
  );
  if (inert) c.header('Content-Security-Policy', "default-src 'none'; sandbox");
}

/**
 * A stored file as an inert download, or 410 when its bytes are gone from storage. `download`
 * forces the attachment disposition and forbids caching, for a self-authenticating ticket URL.
 */
export async function sendStoredAttachment(
  c: Context,
  file: { path: string; mime: string; name: string },
  read: (path: string) => Promise<Buffer>,
  opts: { download?: boolean } = {},
): Promise<Response> {
  let buffer: Buffer;
  try {
    buffer = await read(file.path);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== 'ENOENT') throw err;
    throw new HTTPException(410, {
      message: 'attachment file missing on disk',
      cause: { code: 'ATTACHMENT_FILE_MISSING' },
    });
  }
  setInertAttachmentHeaders(c, file.mime, file.name, opts.download);
  if (opts.download) c.header('Cache-Control', 'private, no-store');
  return sendBytes(c, buffer);
}

/**
 * The byte span a `Range: bytes=…` header asks of a `size`-byte body: `null` when the header is
 * absent or not a single byte range (the whole body is then the answer, as RFC 9110 allows), or
 * `'unsatisfiable'` when it starts past the end.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
}

/** A stored file's bytes, as 206 with the asked span when the request carries a byte range. */
export function sendBytes(c: Context, bytes: Uint8Array): Response {
  c.header('Accept-Ranges', 'bytes');
  const range = byteRange(c.req.header('range'), bytes.length);
  if (range === 'unsatisfiable') {
    c.header('Content-Range', `bytes */${bytes.length}`);
    return c.body(null, 416);
  }
  if (!range) return c.body(new Uint8Array(bytes), 200);
  c.header('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
  return c.body(new Uint8Array(bytes.subarray(range.start, range.end + 1)), 206);
}
