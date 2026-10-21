/**
 * How an HTML mockup runs inside Forge (REQ-49 BC-1): its own scripts run, and it reaches nothing of
 * Forge. Two walls, each enough on its own for the session:
 *
 * - the frame is sandboxed with scripts allowed and never `allow-same-origin`, so the page has an
 *   opaque origin: it cannot read the parent's DOM, cookies or storage, and a request it makes is
 *   cross-site and carries no Forge cookie;
 * - a Content-Security-Policy is written as the page's first element, so no request leaves it for
 *   Forge or anywhere else, bar fonts, styles and scripts from the public CDNs a mockup may load.
 *
 * Both are read by `mockup-isolation.chrome.test.ts`, in a real browser.
 */

/** The frame's sandbox: scripts, nothing else. Never `allow-same-origin`, never top navigation. */
export const MOCKUP_FRAME_SANDBOX = "allow-scripts";

const CDN_SCRIPTS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com";

/** What the page may load: inline code and data, public fonts and CDN libraries; no request to any server. */
export const MOCKUP_FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: data: ${CDN_SCRIPTS}`,
  `style-src 'unsafe-inline' data: https://fonts.googleapis.com ${CDN_SCRIPTS}`,
  "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const escapeAttr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** The policy as the element written first in the page. */
export const MOCKUP_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(MOCKUP_FRAME_CSP)}">`;

// a doctype is kept first, so the page keeps its standards mode; anything else, a comment or a
// `<head>` written inside one included, comes after the policy, which the parser puts in the head
const LEADING_DOCTYPE = /^﻿?\s*<!doctype[^>]*>/i;

/** The page as the frame is given it: the policy first, then the mockup's own bytes, unchanged. */
export function isolatedSrcDoc(html: string): string {
  const doctype = LEADING_DOCTYPE.exec(html)?.[0];
  if (!doctype) return `${MOCKUP_CSP_META}${html}`;
  return `${doctype}${MOCKUP_CSP_META}${html.slice(doctype.length)}`;
}
