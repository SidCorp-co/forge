import type { Context } from 'hono';

// MIME types that can carry executable markup (SVG can embed <script>; HTML
// is script by default). Design-reference uploads need these accepted
// end-to-end (ISS-706 fix B), but a browser opening the download URL with a
// live session cookie must never execute them in the app origin — so they
// are always forced to download instead of rendering inline, with a CSP that
// blocks script execution as a second layer.
const INERT_MIMES = new Set(['image/svg+xml', 'text/html']);

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
  if (INERT_MIMES.has(mime)) {
    c.header('Content-Disposition', `attachment; filename="${name}"`);
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  } else {
    c.header('Content-Disposition', `inline; filename="${name}"`);
  }
}
