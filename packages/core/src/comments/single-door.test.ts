/**
 * Two doors write the `comments` table and nothing else does: `service.ts` for a caller's write,
 * which refuses a stored test credential, and `system-write.ts` for core's own writers, which
 * withhold it. A third writer is a path on which text reaches an issue unchecked, which is how a
 * run-close reason carrying a stored credential was posted whole (ISS-1389).
 *
 * The scan reads each source's syntax tree and follows the table through aliases, namespace
 * imports and re-exports (`single-door.fixture.ts`), so `db.insert(s.comments)` is a write and a
 * comment that says `insert(comments)` is not.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CommentWrite, commentWrites } from './single-door.fixture.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOORS = new Set(['comments/service.ts', 'comments/system-write.ts']);

function sources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.ts$/.test(entry.name) && !/\.(?:test|fixture)\.ts$/.test(entry.name)) {
      out.set(relative(SRC, path).split(sep).join('/'), readFileSync(path, 'utf8'));
    }
  }
  return out;
}

const named = (writes: readonly CommentWrite[]): string[] =>
  writes.map((w) => `${w.file}:${w.line} ${w.how}`);

const PLANTS: Array<[string, string]> = [
  ['the literal table', "import { comments } from '../db/schema.js';\ndb.insert(comments);"],
  ['a namespace import', "import * as s from '../db/schema.js';\ndb.insert(s.comments);"],
  ['an aliased import', "import { comments as c } from '../db/schema.js';\ndb.update(c).set({});"],
];

describe('who writes the comments table', () => {
  const real = sources(SRC);

  it('is the two doors, and a writer outside them fails naming its file and line', () => {
    expect(
      named(commentWrites(real, DOORS)),
      'post through postSystemComment, insertSystemComment or deleteSystemComment (core writing) or insertComment (a caller writing): a direct write skips the stored-credential check',
    ).toEqual([]);
  });

  it.each(PLANTS)('goes red on %s planted in a real source, naming the line', (_form, plant) => {
    const original = real.get('pipeline/reconciler.ts') as string;
    const planted = new Map(real).set('pipeline/reconciler.ts', `${original}\n${plant}\n`);
    const line = original.split('\n').length + 2;
    const found = commentWrites(planted, DOORS);
    expect(found.map((w) => `${w.file}:${w.line}`)).toEqual([`pipeline/reconciler.ts:${line}`]);
  });

  it('keeps a write planted in pm/routes.ts failing, there being no amnesty for the file', () => {
    const original = real.get('pm/routes.ts') as string;
    const plant =
      "import { comments as c } from '../db/schema.js';\nawait db.insert(c).values({});";
    const planted = new Map(real).set('pm/routes.ts', `${original}\n${plant}\n`);
    const found = commentWrites(planted, DOORS);
    expect(found.map((w) => w.file)).toEqual(['pm/routes.ts']);
  });

  it('finds the real schema declaring the table, so a pass is not a scan that found nothing to follow', () => {
    const planted = new Map(real).set(
      'zz/planted.ts',
      "import * as schema from '../db/schema.js';\ndb.delete(schema.comments);",
    );
    expect(named(commentWrites(planted, DOORS))).toEqual([
      'zz/planted.ts:2 .delete(schema.comments)',
    ]);
  });
});
