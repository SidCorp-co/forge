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

// cm:edge contract -> packages/core/src/mcp/tools/forge-issues.ts — this is the checker half of the ISSUE_UPDATE_DATA_KEYS edge; the payloads matched here are hand-written markdown, so any NEW way of spelling an update call must be added to UPDATE_CALL or the gate silently stops covering it.
const UPDATE_CALL = /forge_issues\s*(?:(?:→|->)\s*update|\.update)/g;
const TOP_LEVEL_KEY = /(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;

/** The `data: { ... }` object of every update call, brace-balanced so a nested value never truncates the scan. */
function updatePayloads(text: string): string[] {
  const out: string[] = [];
  for (const call of text.matchAll(UPDATE_CALL)) {
    const from = (call.index ?? 0) + call[0].length;
    const marker = text.slice(from, from + 200).search(/data:\s*\{/);
    if (marker < 0) continue;
    let i = from + marker + text.slice(from + marker).indexOf('{');
    const open = i;
    let depth = 0;
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (text[i] === '\n' && text[i + 1] === '\n') break;
    }
    if (depth === 0) out.push(text.slice(open + 1, i));
  }
  return out;
}

/** Keys at depth 0 of a payload — a nested value's own keys belong to that value's schema, not to this one. */
function topLevelKeys(payload: string): string[] {
  let depth = 0;
  let flat = '';
  for (const ch of payload) {
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (depth === 0) flat += ch;
    else continue;
    if (depth > 0) flat += ' ';
  }
  return [...flat.matchAll(TOP_LEVEL_KEY)].map((m) => m[1] as string);
}

describe('bundled skill field names', () => {
  it('names no issue field that the MCP surface dropped or never had', async () => {
    const files = await collectMarkdown(SKILLS_ROOT);
    // cm:guard the floor tracks the corpus, and the corpus is five operator skills since ISS-895 deleted the eight staged bodies. A floor above what ships turns this gate from "no body names a dropped field" into "the walk is broken", which is the failure it was written to detect, inverted.
    expect(files.length).toBeGreaterThan(4);

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

    const seen: string[] = [];
    const offences: string[] = [];
    for (const { rel, text } of files) {
      for (const payload of updatePayloads(text)) {
        for (const name of topLevelKeys(payload)) {
          seen.push(name);
          if (!accepted.has(name)) offences.push(`${rel}: ${name}`);
        }
      }
    }
    // cm:guard NOT a floor on `seen`: the eight staged bodies were the only ones issuing `forge_issues.update` calls, so the corpus has zero payloads and any positive floor fails on a corpus that is simply correct. The walk is proven by the file count above; this assertion is the rule, and it fires on the first body that writes a key the schema rejects.
    expect(files.length).toBeGreaterThan(4);
    expect(offences).toEqual([]);
  });
});
