import type { Context } from 'hono';

const INERT_MIMES = new Set(['image/svg+xml', 'text/html']);

export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function setInertAttachmentHeaders(c: Context, mime: string, name: string): void {
  c.header('Content-Type', mime);
  c.header('X-Content-Type-Options', 'nosniff');
  const inert = INERT_MIMES.has(mime);
  c.header('Content-Disposition', contentDisposition(inert ? 'attachment' : 'inline', name));
  if (inert) c.header('Content-Security-Policy', "default-src 'none'; sandbox");
}
