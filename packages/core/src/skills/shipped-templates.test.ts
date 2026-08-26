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

const CREATE_EXAMPLE = /forge_comments\s*(?:→|->|\.)\s*create[^\n]*\n?([\s\S]*?)(?:\n```|\n\n)/g;
const DATA_KEY = /^\s{0,8}([A-Za-z][A-Za-z0-9_]*)\s*:/gm;

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
  for (const example of text.matchAll(CREATE_EXAMPLE)) {
    const block = example[1] ?? '';
    const dataAt = block.indexOf('data:');
    if (dataAt === -1) continue;
    for (const key of block.slice(dataAt + 'data:'.length).matchAll(DATA_KEY)) {
      if (key[1]) keys.add(key[1]);
    }
  }
  return [...keys];
}

describe('shipped Markdown templates type-check against the live schema (ISS-787)', () => {
  const templates = shippedTemplates();

  it('finds the templates it claims to check', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.some((t) => t.text.includes('forge_comments'))).toBe(true);
  });

  it.each(templates)('$name shows no forge_comments.create key the schema rejects', ({ text }) => {
    const keys = exampleDataKeys(text);
    const data = Object.fromEntries(keys.map((k) => [k, SCHEMA_PLACEHOLDER[k] ?? 'x']));
    const parsed = commentCreateDataSchema.safeParse(data);

    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toEqual([]);
  });
});
