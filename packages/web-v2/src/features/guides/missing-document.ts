import {
  INDEX_HREF,
  MISSING_GUIDE_BODY,
  MISSING_GUIDE_LINK_TEXT,
  missingGuideHeading,
} from "./missing";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** The slug comes off the URL, so it is caller-controlled and is escaped before
 *  it is written into markup. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

/** A self-contained HTML 404 for `/guides/<unknown>`, served by the middleware.
 *  Deliberately styleless and dependency-free: it is rendered outside React, and
 *  the one thing it owes a reader is the refusal by name and the way back. */
export function missingGuideDocument(slug: string): string {
  const heading = escapeHtml(missingGuideHeading(slug));
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${heading} — Forge guides</title>`,
    `<meta name="description" content="${escapeHtml(MISSING_GUIDE_BODY)}">`,
    '<meta name="robots" content="noindex">',
    "</head><body>",
    `<h1>${heading}</h1>`,
    `<p>${escapeHtml(MISSING_GUIDE_BODY)}</p>`,
    `<p><a href="${INDEX_HREF}">${escapeHtml(MISSING_GUIDE_LINK_TEXT)}</a></p>`,
    "</body></html>",
    "",
  ].join("\n");
}
