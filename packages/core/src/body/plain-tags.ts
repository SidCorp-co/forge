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
