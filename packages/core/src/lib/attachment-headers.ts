import type { Context } from 'hono';

// cm:guard every member carries executable markup (SVG embeds <script>, HTML is script) and must be served `attachment` plus a script-blocking CSP — the download URL is opened with a live session cookie, so rendering one inline runs it in the app origin (ISS-706)
const INERT_MIMES = new Set(['image/svg+xml', 'text/html']);

/**
 * A `Content-Disposition` value that can carry the name the row actually holds.
 *
 * A header value is a ByteString, so any code point above 255 throws on the way
 * out — after the bytes have already been read from storage, which is a 500 on a
 * file that uploaded fine. Attachment names have been able to hold one since the
 * name became an identity and stopped collapsing to underscores (ISS-963), so
 * RFC 5987 is what makes the read path able to serve what the write path accepts:
 * an ASCII `filename=` every client understands, plus `filename*=UTF-8''…` that
 * carries the real name for those that read it.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Set response headers for a served attachment byte stream. Every download
 * route gets `X-Content-Type-Options: nosniff` unconditionally; svg/html
 * additionally get `Content-Disposition: attachment` (never inline) and a
 * locked-down CSP so opening the URL directly can't execute embedded script.
 * Other mimes (images, pdf, text) keep the existing inline behavior needed
 * for the web UI + agent vision to render them.
 */
export function setInertAttachmentHeaders(c: Context, mime: string, name: string): void {
  c.header('Content-Type', mime);
  c.header('X-Content-Type-Options', 'nosniff');
  const inert = INERT_MIMES.has(mime);
  c.header('Content-Disposition', contentDisposition(inert ? 'attachment' : 'inline', name));
  if (inert) c.header('Content-Security-Policy', "default-src 'none'; sandbox");
}
