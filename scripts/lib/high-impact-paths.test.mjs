// @direct-test-of scripts/test-changed.mjs
//
// The declared high-impact paths widen `pnpm test:changed` to its direct core integration tests with
// no flag, and a list entry that is stale, malformed or gives no reason is refused by name (ISS-1061).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  describeWidening,
  HIGH_IMPACT_FILE,
  parseHighImpactPaths,
  readHighImpactPaths,
  widenedBy,
} from './high-impact-paths.mjs';

const TRACKED = [
  'packages/core/drizzle/migrations/0400_new_table.sql',
  'packages/core/drizzle/migrations/meta/_journal.json',
  'packages/core/src/db/schema-issues.ts',
  'packages/core/src/issues/transition-guards.ts',
  'packages/web-v2/src/features/pipeline/components/activity-feed.tsx',
];

const MIGRATIONS = {
  pattern: 'packages/core/drizzle/migrations/**',
  reason: 'a migration changes the schema every query runs on',
};
const SCHEMA = { pattern: 'packages/core/src/db/schema*.ts', reason: 'the Drizzle schema' };

const listOf = (paths, extra = {}) =>
  JSON.stringify({ $why: 'why the list exists', paths, ...extra });
const parsed = (paths, extra) => parseHighImpactPaths(listOf(paths, extra), TRACKED);

describe('a list held to the tree', () => {
  it('reads each entry whose pattern matches a tracked file', () => {
    const r = parsed([MIGRATIONS, SCHEMA]);
    expect(r.refusal).toBeUndefined();
    expect(r.entries.map((e) => [e.pattern, e.reason])).toEqual([
      [MIGRATIONS.pattern, MIGRATIONS.reason],
      [SCHEMA.pattern, SCHEMA.reason],
    ]);
  });

  it('refuses an entry matching no tracked file by name, HIGH_IMPACT_ENTRY_STALE', () => {
    const r = parsed([
      MIGRATIONS,
      { pattern: 'packages/core/src/issues/gone.ts', reason: 'moved' },
    ]);
    expect(r.refusal).toMatch(
      /HIGH_IMPACT_ENTRY_STALE: paths\[1\] "packages\/core\/src\/issues\/gone\.ts" matches no tracked file/,
    );
    expect(r.refusal).toContain(HIGH_IMPACT_FILE);
  });

  it('a stale entry is refused even where the rest of the list is sound, and the sound ones are not named', () => {
    const r = parsed([MIGRATIONS, SCHEMA, { pattern: 'packages/billing/**', reason: 'money' }]);
    expect(r.refusal.match(/HIGH_IMPACT_/g)).toHaveLength(1);
    expect(r.refusal).toContain('"packages/billing/**"');
  });

  it('refuses an entry with no reason, an empty one or one of spaces, HIGH_IMPACT_REASON_MISSING', () => {
    for (const reason of [undefined, '', '   ', 7]) {
      const entry = { pattern: SCHEMA.pattern, ...(reason === undefined ? {} : { reason }) };
      expect(parsed([entry]).refusal).toMatch(
        /HIGH_IMPACT_REASON_MISSING: paths\[0\] "packages\/core\/src\/db\/schema\*\.ts" gives no reason/,
      );
    }
  });

  it('refuses a malformed entry by its index and what is wrong, HIGH_IMPACT_ENTRY_MALFORMED', () => {
    const cases = [
      ['a string', 'is not { "pattern", "reason" }'],
      [{ reason: 'no pattern' }, 'has no pattern'],
      [{ pattern: '', reason: 'empty' }, 'has no pattern'],
      [{ pattern: '/packages/core/**', reason: 'r' }, 'is not repo-relative'],
      [{ pattern: './packages/core/**', reason: 'r' }, 'is not repo-relative'],
      [{ pattern: 'packages/../core/**', reason: 'r' }, 'climbs out with ".."'],
      [{ pattern: 'packages/core/{a,b}.ts', reason: 'r' }, 'it takes "*" and "**" only'],
      [{ pattern: 'packages/core/a?.ts', reason: 'r' }, 'it takes "*" and "**" only'],
      [{ pattern: ' packages/core/**', reason: 'r' }, 'surrounding whitespace'],
      [{ ...SCHEMA, why: 'a typo of reason' }, 'carries unknown key(s) "why"'],
    ];
    for (const [entry, says] of cases) {
      const r = parsed([MIGRATIONS, entry]);
      expect([entry, r.refusal]).toEqual([
        entry,
        expect.stringContaining('HIGH_IMPACT_ENTRY_MALFORMED: paths[1]'),
      ]);
      expect([entry, r.refusal]).toEqual([entry, expect.stringContaining(says)]);
    }
  });

  it('refuses a pattern listed twice', () => {
    expect(parsed([SCHEMA, SCHEMA]).refusal).toMatch(/paths\[1\] "[^"]+" is listed twice/);
  });

  it('refuses a document that is not the list, HIGH_IMPACT_LIST_MALFORMED', () => {
    for (const [text, says] of [
      ['{ "paths": [', 'not JSON'],
      ['[]', 'the document is not an object'],
      ['null', 'the document is not an object'],
      [listOf([]), '"paths" is not a non-empty list'],
      [JSON.stringify({ paths: { a: 1 } }), '"paths" is not a non-empty list'],
      [listOf([SCHEMA], { entries: [] }), 'unknown key(s) "entries"'],
      [JSON.stringify({ $why: '', paths: [SCHEMA] }), '"$why" is not a sentence'],
    ]) {
      const r = parseHighImpactPaths(text, TRACKED);
      expect([text, r.refusal]).toEqual([
        text,
        expect.stringContaining(`HIGH_IMPACT_LIST_MALFORMED: ${says}`),
      ]);
    }
  });

  it('names every fault at once, not only the first', () => {
    const r = parsed([{ pattern: 'nowhere/**', reason: 'r' }, { pattern: SCHEMA.pattern }]);
    expect(r.refusal).toContain('HIGH_IMPACT_ENTRY_STALE: paths[0]');
    expect(r.refusal).toContain('HIGH_IMPACT_REASON_MISSING: paths[1]');
  });
});

describe('what widens a run', () => {
  const { entries } = parsed([MIGRATIONS, SCHEMA]);

  it('a touched migration widens it, naming the path, its pattern and its reason', () => {
    const widening = widenedBy(['packages/core/drizzle/migrations/0400_new_table.sql'], entries);
    expect(widening).toEqual([
      {
        path: 'packages/core/drizzle/migrations/0400_new_table.sql',
        pattern: MIGRATIONS.pattern,
        reason: MIGRATIONS.reason,
      },
    ]);
    const lines = describeWidening(widening, { flagged: false });
    expect(lines[0]).toContain('with no --integration');
    expect(lines[1]).toBe(
      `    packages/core/drizzle/migrations/0400_new_table.sql  ← ${MIGRATIONS.pattern}: ${MIGRATIONS.reason}`,
    );
  });

  it('a migration under a nested directory widens it: "**" crosses segments', () => {
    expect(
      widenedBy(['packages/core/drizzle/migrations/meta/_journal.json'], entries),
    ).toHaveLength(1);
  });

  it('a web component touched alone widens nothing, and prints nothing', () => {
    const widening = widenedBy(
      ['packages/web-v2/src/features/pipeline/components/activity-feed.tsx'],
      entries,
    );
    expect(widening).toEqual([]);
    expect(describeWidening(widening, { flagged: false })).toEqual([]);
  });

  it('"*" stays inside one segment, and a pattern is anchored at both ends', () => {
    expect(widenedBy(['packages/core/src/db/sub/schema-x.ts'], entries)).toEqual([]);
    expect(widenedBy(['packages/core/src/db/schema-x.ts.bak'], entries)).toEqual([]);
    expect(widenedBy(['vendor/packages/core/drizzle/migrations/x.sql'], entries)).toEqual([]);
  });

  it('with --integration passed it says the paths would have widened the run', () => {
    const widening = widenedBy(['packages/core/src/db/schema-issues.ts'], entries);
    expect(describeWidening(widening, { flagged: true })[0]).toContain(
      '--integration was passed; these touched high-impact paths',
    );
  });
});

describe("a checkout's list", () => {
  const dirs = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const repo = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'high-impact-'));
    dirs.push(root);
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git('init', '-q');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git('add', '-A');
    return { root, write: (path, text) => writeFileSync(join(root, path), text) };
  };

  it('is refused HIGH_IMPACT_LIST_MISSING where the file is absent: no list widens nothing in silence', () => {
    const { root } = repo({ 'a.txt': 'a' });
    expect(readHighImpactPaths(root).refusal).toMatch(
      /^HIGH_IMPACT_LIST_MISSING: \.forge\/high-impact-paths\.json/,
    );
  });

  it('is held to what git tracks: a file only on disk does not keep an entry alive', () => {
    const { root, write } = repo({
      [HIGH_IMPACT_FILE]: listOf([{ pattern: 'db/migrations/**', reason: 'schema' }]),
      'a.txt': 'a',
    });
    mkdirSync(join(root, 'db/migrations'), { recursive: true });
    write('db/migrations/0001.sql', 'select 1;');
    expect(readHighImpactPaths(root).refusal).toContain(
      'HIGH_IMPACT_ENTRY_STALE: paths[0] "db/migrations/**"',
    );
    spawnSync('git', ['add', 'db/migrations/0001.sql'], { cwd: root });
    const read = readHighImpactPaths(root);
    expect(read.refusal).toBeUndefined();
    expect(read.entries.map((e) => e.pattern)).toEqual(['db/migrations/**']);
  });
});
