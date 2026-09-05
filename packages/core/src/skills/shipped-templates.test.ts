import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/stub', UPLOADS_MAX_BYTES: 1024 },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { commentCreateDataSchema } = await import('../mcp/tools/forge-comments.js');

/**
 * The shipped SKILL.md templates are copied verbatim by agents, so an example
 * key the live schema rejects is a defect that reaches every project at once.
 * ISS-787: 11 `author:` occurrences across 7 templates each earned a hard
 * rejection from `forge_comments.create`'s `.strict()` data schema.
 *
 * The check parses the examples against the schema itself rather than
 * grepping for `author` — a key list restated here would go stale the next
 * time the schema changes, which is the failure mode this file exists to stop.
 */

const SKILLS_ROOT = path.resolve(import.meta.dirname, '../../skills');

const CREATE_DATA_BLOCK =
  /forge_comments\s*(?:→|->|\.)\s*create[\s\S]{0,200}?data:\s*\{([\s\S]*?)\}/g;
const DATA_KEY = /([A-Za-z][A-Za-z0-9_]*)\s*:/g;

const SCHEMA_PLACEHOLDER: Record<string, unknown> = {
  body: 'x',
  issue: '11111111-1111-4111-8111-111111111111',
  parentId: '22222222-2222-4222-8222-222222222222',
  attachments: [],
};

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
  });
}

function shippedTemplates(): { name: string; text: string }[] {
  return markdownFiles(SKILLS_ROOT).map((filePath) => ({
    name: path.relative(SKILLS_ROOT, filePath),
    text: readFileSync(filePath, 'utf8'),
  }));
}

/** Key names shown inside a `data: { … }` block of a create example. */
function exampleDataKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const example of text.matchAll(CREATE_DATA_BLOCK)) {
    for (const key of (example[1] ?? '').matchAll(DATA_KEY)) {
      if (key[1]) keys.add(key[1]);
    }
  }
  return [...keys];
}

describe('shipped Markdown templates type-check against the live schema (ISS-787)', () => {
  const templates = shippedTemplates();

  // cm:guard the canary asserts the WALK, not a `body` key. The 11 `author:` occurrences this was written against (ISS-787) lived in the eight staged bodies ISS-895 deleted, so no surviving template carries a `forge_comments.create` example and `toContain('body')` now fails on a corpus that is correct. Each template is still parsed against the live schema below, which is the rule itself.
  it('reads the shipped template corpus it claims to check', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates)('$name shows no forge_comments.create key the schema rejects', ({ text }) => {
    const keys = exampleDataKeys(text);
    const data = Object.fromEntries(keys.map((k) => [k, SCHEMA_PLACEHOLDER[k] ?? 'x']));
    const parsed = commentCreateDataSchema.safeParse(data);

    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toEqual([]);
  });
});
