import {
  INDEX_HREF,
  MISSING_GUIDE_BODY,
  MISSING_GUIDE_LINK_TEXT,
  missingGuideHeading,
  type Refusal,
} from "./missing";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** The slug comes off the URL, so it is caller-controlled. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

/** A self-contained HTML 404 for an address on the public documentation naming nothing, served
 *  by the middleware. Styleless and dependency-free: it is rendered outside React. */
export function refusalDocument({ heading, body }: Refusal): string {
  const h = escapeHtml(heading);
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${h} — Forge guides</title>`,
    `<meta name="description" content="${escapeHtml(body)}">`,
    '<meta name="robots" content="noindex">',
    "</head><body>",
    `<h1>${h}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${INDEX_HREF}">${escapeHtml(MISSING_GUIDE_LINK_TEXT)}</a></p>`,
    "</body></html>",
    "",
  ].join("\n");
}

/** The 404 for `/guides/<unknown>`. */
export function missingGuideDocument(slug: string): string {
  return refusalDocument({ heading: missingGuideHeading(slug), body: MISSING_GUIDE_BODY });
}
