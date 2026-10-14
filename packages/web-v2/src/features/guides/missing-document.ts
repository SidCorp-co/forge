import {
  AUDIENCES,
  DOORS,
  doorHref,
  INDEX_PATH,
  SITE_CAPTION,
  SITE_NAME,
} from "./audience";
import { assetPath } from "@/lib/asset";
import { ALL_DOORS_LINK_TEXT, MISSING_GUIDE_BODY, missingGuideHeading, type Refusal } from "./missing";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** The slug comes off the URL, so it is caller-controlled. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

/** The colours the document paints with, as `src/styles/tokens.css` resolves each in the light
 *  theme; `missing-document.test.ts` holds them to it. */
export const DOCUMENT_TOKENS = {
  "--bg-app": "#FBFAF8",
  "--fg-default": "#181B22",
  "--fg-muted": "#5A616E",
  "--fg-subtle": "#767D8A",
  "--border-default": "#E4E0D8",
  "--link": "#2D5BD6",
} as const;

/** The app's own font file, served from a path that does not change, and so the one a document
 *  the middleware writes can name. */
export const FONT_SANS_URL = assetPath("/fonts/hanken-grotesk-latin-variable.woff2");

const FONT_SANS =
  '"Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const TOKEN_DECLARATIONS = Object.entries(DOCUMENT_TOKENS)
  .map(([name, value]) => `${name}:${value}`)
  .join(";");

const STYLE = `
@font-face{font-family:"Hanken Grotesk";font-style:normal;font-weight:100 900;font-display:swap;src:url("${FONT_SANS_URL}") format("woff2")}
:root{color-scheme:light;${TOKEN_DECLARATIONS}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-app);color:var(--fg-default);font:15px/1.55 ${FONT_SANS};-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
a:hover{opacity:.8}
header{border-bottom:1px solid var(--border-default)}
.bar,main{max-width:72rem;margin:0 auto;padding-left:1rem;padding-right:1rem}
.bar{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .75rem;padding-top:1.25rem;padding-bottom:1.25rem}
main{padding-top:2rem;padding-bottom:2rem}
.brand{font-weight:600;font-size:17px;line-height:1.3;letter-spacing:-.006em;color:var(--fg-default);text-decoration:none}
.caption{font-weight:500;font-size:12px;line-height:1.35;color:var(--fg-subtle)}
.refusal{display:flex;flex-direction:column;gap:1rem;max-width:72ch;margin:0 auto;padding:2rem 0}
h1{margin:0;font-weight:700;font-size:22px;line-height:1.2;letter-spacing:-.012em;overflow-wrap:anywhere}
.refusal p{margin:0;font-weight:400;font-size:13.5px;line-height:1.5;color:var(--fg-muted);overflow-wrap:anywhere}
nav{display:flex;flex-direction:column;gap:.25rem}
@media (min-width:640px){.bar,main{padding-left:1.5rem;padding-right:1.5rem}}
`
  .trim()
  .replace(/\n/g, "");

/** A self-contained HTML 404 for an address naming nothing, served by the middleware, which can
 *  neither render React nor name the app's hashed stylesheet. It shows what `GuideShell` and
 *  `PublicRefusal` show a client-side navigation. */
export function refusalDocument({ heading, body }: Refusal): string {
  const h = escapeHtml(heading);
  const doors = AUDIENCES.map(
    (a) => `<a href="${doorHref(a)}">${escapeHtml(DOORS[a].label)}</a>`,
  ).join("");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${h} — ${escapeHtml(SITE_NAME)}</title>`,
    `<meta name="description" content="${escapeHtml(body)}">`,
    '<meta name="robots" content="noindex">',
    `<link rel="preload" href="${FONT_SANS_URL}" as="font" type="font/woff2" crossorigin>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    `<header><div class="bar"><a class="brand" href="${INDEX_PATH}">${escapeHtml(SITE_NAME)}</a>`,
    `<span class="caption">${escapeHtml(SITE_CAPTION)}</span></div></header>`,
    "<main>",
    '<div class="refusal">',
    `<h1>${h}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    `<nav aria-label="Ways in">${doors}<a href="${INDEX_PATH}">${escapeHtml(ALL_DOORS_LINK_TEXT)}</a></nav>`,
    "</div>",
    "</main>",
    "</body></html>",
    "",
  ].join("\n");
}

/** The 404 for `/guides/<unknown>`. */
export function missingGuideDocument(slug: string): string {
  return refusalDocument({ heading: missingGuideHeading(slug), body: MISSING_GUIDE_BODY });
}
