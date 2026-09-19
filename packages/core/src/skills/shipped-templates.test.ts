import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/stub', UPLOADS_MAX_BYTES: 1024 },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { commentCreateDataSchema } = await import('../mcp/tools/forge-comments.js');

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
