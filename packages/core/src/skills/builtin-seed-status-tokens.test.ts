import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';

// Mirrors `defaultSkillsRoot()` in builtin-seed.ts: this test lives at
// `src/skills/`, and the seeded skill bodies live at `<pkg-root>/skills/`.
const SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));

// Matches `status: "foo"` / `status: 'foo'` transition literals while
// excluding compound fields like `previewStatus:`/`taskStatus:` (the
// lookbehind requires the char before "status:" not be a letter).
const STATUS_LITERAL_RE = /(?<![A-Za-z])status:\s*["']([a-z_]+)["']/g;

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(abs)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(abs);
    }
  }
  return files;
}

describe('builtin seed skills: status transition literals', () => {
  it('every `status: "..."` literal in a seed skill is a valid issue status', async () => {
    const files = await findMarkdownFiles(SKILLS_ROOT);
    const validStatuses = new Set<string>(issueStatuses);
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const relPath = path.relative(SKILLS_ROOT, file);
      for (const match of content.matchAll(STATUS_LITERAL_RE)) {
        const token = match[1];
        scanned += 1;
        if (!validStatuses.has(token)) {
          offenders.push(`${relPath}: "${token}"`);
        }
      }
    }

    // Guards against a broken walk (empty dir, wrong root) silently passing.
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
