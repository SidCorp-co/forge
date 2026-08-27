/**
 * The bundled skill markdown under `packages/core/skills` is prose, so nothing
 * type-checks the issue field names it tells agents to read and write. Both
 * halves have been wrong in production: `previewUrl`/`previewApiUrl`/
 * `previewStatus` were instructed as writes for months and never existed in any
 * migration, and six columns dropped by `0188` outlived their removal in four
 * skills. A write payload naming an unknown key fails the entire call, `status`
 * included, because the update schema is `.strict()`.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const { ISSUE_UPDATE_DATA_KEYS } = await import('../mcp/tools/forge-issues.js');

const SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));

const DROPPED_ISSUE_FIELDS = [
  'aiSummary',
  'aiSuggestedSolution',
  'aiAcceptanceCriteria',
  'aiConfidence',
  'suggestedSolution',
  'parentIssueId',
  'previewUrl',
  'previewApiUrl',
  'previewStatus',
  'changeHistory',
];

async function collectMarkdown(dir: string): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md'))
        out.push({ rel: path.relative(SKILLS_ROOT, full), text: await readFile(full, 'utf8') });
    }
  };
  await walk(dir);
  return out;
}

// cm:edge contract -> packages/core/src/mcp/tools/forge-issues.ts — this is the checker half of the ISSUE_UPDATE_DATA_KEYS edge; the payloads matched here are hand-written markdown, so extending the regex is what keeps a new skill-authoring style from slipping past it.
const UPDATE_PAYLOAD = /forge_issues\s*(?:→|->)\s*update[^\n]*?data:\s*\{([^}]*)\}/g;
const KEY_IN_PAYLOAD = /(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g;

describe('bundled skill field names', () => {
  it('names no issue field that the MCP surface dropped or never had', async () => {
    const files = await collectMarkdown(SKILLS_ROOT);
    expect(files.length).toBeGreaterThan(10);

    const offences = files.flatMap(({ rel, text }) =>
      DROPPED_ISSUE_FIELDS.filter((field) => new RegExp(`\\b${field}\\b`).test(text)).map(
        (field) => `${rel}: ${field}`,
      ),
    );
    expect(offences).toEqual([]);
  });

  it('writes only keys the strict update schema accepts', async () => {
    const files = await collectMarkdown(SKILLS_ROOT);
    const accepted = new Set(ISSUE_UPDATE_DATA_KEYS);
    expect(accepted.has('status')).toBe(true);

    const offences: string[] = [];
    for (const { rel, text } of files) {
      for (const payload of text.matchAll(UPDATE_PAYLOAD)) {
        for (const key of (payload[1] ?? '').matchAll(KEY_IN_PAYLOAD)) {
          const name = key[1] as string;
          if (!accepted.has(name)) offences.push(`${rel}: ${name}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});
