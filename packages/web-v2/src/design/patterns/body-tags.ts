// The compact styling for the plain-HTML tag set, in one place because two
// renderers now emit it: `markdown.tsx` (via react-markdown, from GFM) and
// `body-view.tsx` (from a `format:'html'` node tree). The tag set itself is
// core's `body/plain-tags.ts` allowlist, which is bounded by "exactly what
// remark-gfm already emits" — so one class per tag covers both.

// cm:edge contract -> packages/core/src/body/plain-tags.ts — that file's `PLAIN_TAGS` is the closed set a stored body may carry, and this map is what draws it. A tag added there without an entry here renders unstyled; an entry here for a tag core refuses is dead.
export const COMPACT_TAG_CLASS: Record<string, string> = {
  h1: "fg-h3 mt-4 mb-2 first:mt-0",
  h2: "fg-h3 mt-4 mb-2 first:mt-0",
  h3: "fg-label mt-3 mb-1.5 first:mt-0",
  h4: "fg-label mt-3 mb-1.5 first:mt-0",
  p: "fg-body-sm my-2 leading-relaxed first:mt-0 last:mb-0",
  ul: "fg-body-sm my-2 list-disc space-y-1 pl-5",
  ol: "fg-body-sm my-2 list-decimal space-y-1 pl-5",
  li: "leading-relaxed",
  blockquote: "my-2 border-l-2 border-line-strong pl-3 text-muted",
  pre: "my-2 overflow-x-auto",
  table: "w-full border-collapse text-left text-[12.5px]",
  thead: "",
  tbody: "",
  tr: "",
  th: "border-b border-line px-2 py-1 font-mono text-muted",
  td: "border-b border-line-subtle px-2 py-1 text-fg",
  hr: "my-3 border-line",
  img: "my-3 max-w-full rounded-md border border-line",
  b: "font-semibold",
  strong: "font-semibold",
  i: "italic",
  em: "italic",
  kbd: "rounded-sm border border-line bg-sunken px-1 font-mono text-[11.5px]",
  details: "my-2 rounded-md border border-line bg-sunken px-3 py-2",
  summary: "fg-label cursor-pointer",
  br: "",
};

export const LINK_CLASS = "text-[color:var(--link)] underline underline-offset-2 hover:opacity-80";

export const CODE_BLOCK_CLASS =
  "block overflow-x-auto rounded-md bg-sunken p-3 font-mono text-[12.5px] text-fg";

export const CODE_INLINE_CLASS =
  "rounded-sm bg-sunken px-1 py-0.5 font-mono text-[12.5px] text-fg";
