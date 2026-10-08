// A body is a file in content/, embedded by scripts/gen-guide-content.mjs. `{{NAME}}` marks a value
// the code owns; a name, value or slug that does not pair up is refused when the guide is read.

import { GUIDE_CONTENT } from './content.generated.js';

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

/** The body of guide `slug` with each `{{NAME}}` replaced by `values.NAME`. */
export function guideBody(
  slug: string,
  values: Readonly<Record<string, string>> = {},
  content: Readonly<Record<string, string>> = GUIDE_CONTENT,
): string {
  const raw = content[slug];
  if (raw === undefined) {
    throw new Error(
      `guide '${slug}' has no body: expected packages/core/src/guides/content/${slug}.md, run \`pnpm gen:guides\` after adding it`,
    );
  }
  const named = new Set([...raw.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  const unfilled = [...named].filter((n) => !Object.hasOwn(values, n));
  if (unfilled.length > 0) {
    throw new Error(
      `guide '${slug}' holds {{${unfilled.join('}}, {{')}}} and the code supplies no value for it`,
    );
  }
  const unused = Object.keys(values).filter((n) => !named.has(n));
  if (unused.length > 0) {
    throw new Error(
      `guide '${slug}' is given ${unused.join(', ')} and its body has no {{${unused[0]}}} to put it in`,
    );
  }
  return raw.replace(PLACEHOLDER, (_, name: string) => values[name] as string);
}

/** The slugs that have a body file, for the check that no file is left without a guide. */
export function guideContentSlugs(content: Readonly<Record<string, string>> = GUIDE_CONTENT) {
  return Object.keys(content);
}
