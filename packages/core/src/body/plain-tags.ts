/**
 * The plain-HTML half of a component body: which tags carry prose, which
 * attributes survive on them, and which elements are dropped whole.
 *
 * The allowlist is Decision 1 of ISS-898 verbatim. Its bound is not taste: it
 * is exactly the tag set `react-markdown` + `remark-gfm` already emits from
 * GFM, so rendering an allowlisted body reaches no element the markdown
 * renderer could not already produce. Widening it widens the render surface.
 */

// cm:edge contract -> packages/web-v2/src/design/patterns/markdown.tsx — this set is the tags GFM already produces there. A tag added here that the markdown renderer never emits is a NEW render surface, and P2's component renderer inherits it.
export const PLAIN_TAGS = new Set([
  'p',
  'br',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'b',
  'strong',
  'i',
  'em',
  'code',
  'pre',
  'a',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'details',
  'summary',
  'kbd',
  'hr',
  'img',
]);

/** Tags with no closing form. `<br>`, `<br/>` and `<br />` all parse. */
export const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Elements whose CONTENT is dropped with them rather than unwrapped.
 *
 * An unknown tag keeps its text (`<div>hi</div>` → `hi`) because the text is
 * the author's prose. These five carry payload, not prose: unwrapping
 * `<script>alert(1)</script>` would leave `alert(1)` as visible text, which
 * reports as sanitized while still delivering the attacker's string to every
 * reader. Decision 2 names the same list.
 */
// cm:guard drop the subtree, never unwrap it — unwrapping a <script> leaves its source as prose and reads as if sanitizing worked
export const DROPPED_ELEMENTS = new Set(['script', 'style', 'iframe', 'object', 'embed']);

/** Per-tag attribute allowlist. A tag absent from this map takes no attributes. */
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ['href'],
  img: ['src', 'alt'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  details: ['open'],
};

export function plainAttrAllowed(tag: string, attr: string): boolean {
  return (TAG_ATTRS[tag] ?? []).includes(attr);
}

/**
 * `href` / `src` schemes a body may carry. Anything else — `javascript:`,
 * `data:`, `vbscript:` — is dropped with a warning rather than rewritten,
 * because a rewritten URL is a guess at what the author meant.
 */
const SAFE_URL = /^(?:https?:\/\/|\/|\.\/|#|mailto:)/i;

export function urlAllowed(value: string): boolean {
  return SAFE_URL.test(value.trim());
}
