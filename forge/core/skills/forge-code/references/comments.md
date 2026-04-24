# Comment Style Guide

Balanced tone — enough detail for devs to understand scope, readable enough for non-devs.

## Format

- Bold section headers for grouping related changes
- List features/fixes with brief descriptions (what + why, not how)
- No file paths, function names, or code snippets
- No commit hashes unless relevant

## Good Example

> **Live token usage** — Agent chat now shows a context window progress bar with % remaining until compact. Available in both desktop and web.

## Too Detailed (avoid)

> Added `usage` JSON field to `agent-session` schema in `forge/strapi/src/api/agent-session/content-types/agent-session/schema.json`. Strapi relay controller accumulates usage from streamed messages via `accumulateMessage()`.

## Too Brief (avoid)

> Added usage tracking.

## Template

```markdown
**<Feature/Fix name>** — <What changed and why, in 1-2 sentences>.
```

For multi-part changes, use multiple bolded items.
