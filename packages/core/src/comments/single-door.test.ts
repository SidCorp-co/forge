/**
 * Two doors write the `comments` table and nothing else does: `service.ts` for a caller's write,
 * which refuses a stored test credential, and `system-write.ts` for core's own writers, which
 * withhold it. A third writer is a path on which text reaches an issue unchecked, which is how a
 * run-close reason carrying a stored credential was posted whole (ISS-1389).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOORS = new Set(['comments/service.ts', 'comments/system-write.ts']);

const WRITES = [
  /\.(insert|update)\(\s*comments\s*\)/g,
  /\binsert\s+into\s+"?comments"?\b/gi,
  /\bupdate\s+(?:only\s+)?"?comments"?\s+set\b/gi,
];

const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

/** The 1-based lines of `source` that write the comments table. */
function commentWriteLines(source: string): number[] {
  const text = stripComments(source);
  const lines = new Set<number>();
  for (const pattern of WRITES) {
    for (const hit of text.matchAll(pattern)) {
      lines.add(text.slice(0, hit.index).split('\n').length);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('the scan sees a write of the comments table', () => {
  it('finds a drizzle insert and update, and raw SQL, by line', () => {
    const source = [
      'await tx.insert(comments).values({});',
      'const other = 1;',
      'await db',
      '  .update(comments)',
      '  .set({});',
      'await db.execute(sql`INSERT INTO comments (id) VALUES (1)`);',
    ].join('\n');
    expect(commentWriteLines(source)).toEqual([1, 4, 6]);
  });

  it('does not read a comment, a select, or another table as a write', () => {
    const source = [
      '// await tx.insert(comments).values({});',
      "/* db.update(comments) */ const x = 'text';",
      'await db.select().from(comments);',
      'await db.insert(commentAttachments).values({});',
    ].join('\n');
    expect(commentWriteLines(source)).toEqual([]);
  });
});

describe('who writes the comments table', () => {
  it('is the two doors, and a writer outside them fails naming its file and line', () => {
    const faults = sources(SRC).flatMap((path) => {
      const rel = relative(SRC, path).split(sep).join('/');
      if (DOORS.has(rel)) return [];
      return commentWriteLines(readFileSync(path, 'utf8')).map((line) => `${rel}:${line}`);
    });
    expect(
      faults,
      'post through postSystemComment or insertSystemComment (core writing) or insertComment (a caller writing): a direct write skips the stored-credential check',
    ).toEqual([]);
  });
});
