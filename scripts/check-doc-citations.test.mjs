import { describe, expect, it } from 'vitest';
import { citationsIn, homeOf, judge, resolveCitation } from './check-doc-citations.mjs';

// FIXTURE TEXT — markdown this checker parses, not markdown this file renders.

/** A tree the judgement can be run against without a checkout. */
function world(files, { ignored = [], symbols = {}, changed = {} } = {}) {
  const dirs = new Set();
  const manifestDirs = new Set();
  for (const p of files) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (parts.at(-1) === 'package.json' || parts.at(-1) === 'Cargo.toml') {
      manifestDirs.add(parts.slice(0, -1).join('/'));
    }
  }
  return {
    files,
    dirs: [...dirs],
    manifestDirs,
    topLevel: new Set(files.map((p) => p.split('/')[0])),
    ignored: (p) => ignored.includes(p),
    contains: (p, symbol) => (symbols[p] ?? []).includes(symbol),
    changedAt: (p) => changed[p] ?? 1,
  };
}

const PACKAGES = [
  'package.json',
  'packages/core/package.json',
  'packages/core/src/index.ts',
  'packages/core/src/db/client.ts',
  'packages/web-v2/package.json',
  'packages/web-v2/src/index.ts',
];

const scan = (source, rel = 'packages/core/README.md') => citationsIn(rel, source);
const measured = (source, rel) => scan(source, rel).filter((c) => !c.excused);
const run = (source, rel, tree, opts) => judge(scan(source, rel), world(tree, opts));

describe('check-doc-citations — a claim about a file that is not there', () => {
  it('fails a citation carrying a directory that no tracked file matches', () => {
    const { dead } = run(
      'See `src/db/gone.ts` for the pool.\n',
      'packages/core/README.md',
      PACKAGES,
    );
    expect(dead.map((c) => c.token)).toEqual(['src/db/gone.ts']);
  });

  it('fails a bare source filename that no tracked file matches', () => {
    const { dead } = run(
      'The invariant is held by `no-transport-db.test.ts`.\n',
      'packages/core/README.md',
      PACKAGES,
    );
    expect(dead.map((c) => c.token)).toEqual(['no-transport-db.test.ts']);
  });

  it('passes a citation the tree does hold', () => {
    const { dead } = run('The app is `src/index.ts`.\n', 'packages/core/README.md', PACKAGES);
    expect(dead).toEqual([]);
  });
});

describe('check-doc-citations — a citation resolves inside its own package', () => {
  const CORE_DELETED = PACKAGES.filter((p) => p !== 'packages/core/src/index.ts');

  it("fails when the citing package's file is deleted and another package keeps the namesake", () => {
    const { dead, ambiguous } = run(
      'The app is `src/index.ts`.\n',
      'packages/core/README.md',
      CORE_DELETED,
    );
    expect(dead.map((c) => c.token)).toEqual(['src/index.ts']);
    expect(ambiguous).toEqual([]);
  });

  it('fails it whether or not the cited directory itself survives', () => {
    const noSrcAtAll = CORE_DELETED.filter((p) => !p.startsWith('packages/core/src/'));
    const { dead } = run('The app is `src/index.ts`.\n', 'packages/core/README.md', noSrcAtAll);
    expect(dead.map((c) => c.token)).toEqual(['src/index.ts']);
  });

  it('keeps a DELETED root-relative citation dead rather than falling through to a nested namesake', () => {
    const nested = [
      'package.json',
      'scripts/README.md',
      'packages/demo/package.json',
      'packages/demo/scripts/gone.mjs',
    ];
    const { dead } = run('Run `scripts/gone.mjs`.\n', 'scripts/README.md', nested);
    expect(dead.map((c) => c.token)).toEqual(['scripts/gone.mjs']);
  });

  it('keeps a deleted ROOT-LEVEL file dead where only a nested namesake survives', () => {
    const nested = ['package.json', 'README.md', 'packages/demo/eslint.config.mjs'];
    const { dead } = run('Configured in `eslint.config.mjs`.\n', 'README.md', nested);
    expect(dead.map((c) => c.token)).toEqual(['eslint.config.mjs']);
  });

  it("resolves shorthand under the document's own directory as well as its package", () => {
    const tree = [
      'package.json',
      'packages/core/package.json',
      'packages/core/tests/README.md',
      'packages/core/tests/helpers/container.ts',
    ];
    const { dead } = run(
      'Started by `tests/helpers/container.ts`.\n',
      'packages/core/tests/README.md',
      tree,
    );
    expect(dead).toEqual([]);
  });

  it('gives a document at the repository root the exact path and no shorthand at all', () => {
    const { dead } = run('The app is `src/index.ts`.\n', 'README.md', PACKAGES);
    expect(dead.map((c) => c.token)).toEqual(['src/index.ts']);
  });

  it('resolves a path written from the repository root wherever the document sits', () => {
    const { dead } = run(
      'Mounted in `packages/web-v2/src/index.ts`.\n',
      'packages/core/README.md',
      PACKAGES,
    );
    expect(dead).toEqual([]);
  });

  it('homes a document at its nearest manifest, and at the root where there is none', () => {
    const { manifestDirs } = world(PACKAGES);
    expect(homeOf('packages/core/src/db/README.md', manifestDirs)).toBe('packages/core');
    expect(homeOf('scripts/README.md', manifestDirs)).toBe('');
  });

  it('resolves a document-relative citation against the document and nowhere else', () => {
    const c = scan('Declared in `../index.ts`.\n', 'packages/core/src/db/README.md')[0];
    expect(resolveCitation(c, 'packages/core', world(PACKAGES))).toEqual([
      'packages/core/src/index.ts',
    ]);
  });
});

describe('check-doc-citations — the two shapes CLAUDE.md already forbids', () => {
  it('fails a citation that names a line number', () => {
    const { numbered } = run(
      'Thrown at `src/index.ts:137`.\n',
      'packages/core/README.md',
      PACKAGES,
    );
    expect(numbered.map((c) => c.token)).toEqual(['src/index.ts:137']);
  });

  it('fails an anchor whose file does not hold the symbol', () => {
    const { badAnchor } = run(
      'See `src/index.ts:mountRoutes`.\n',
      'packages/core/README.md',
      PACKAGES,
      {
        symbols: { 'packages/core/src/index.ts': ['createApp'] },
      },
    );
    expect(badAnchor.map((c) => c.symbol)).toEqual(['mountRoutes']);
  });

  it('passes an anchor whose file does hold the symbol', () => {
    const { badAnchor, dead } = run(
      'See `src/index.ts:createApp`.\n',
      'packages/core/README.md',
      PACKAGES,
      { symbols: { 'packages/core/src/index.ts': ['createApp'] } },
    );
    expect([...badAnchor, ...dead]).toEqual([]);
  });
});

describe('check-doc-citations — what reports instead of failing', () => {
  it('puts a live citation whose target moved after the document on the worklist', () => {
    const { drift, dead } = run(
      'The app is `src/index.ts`.\n',
      'packages/core/README.md',
      PACKAGES,
      {
        changed: { 'packages/core/README.md': 100, 'packages/core/src/index.ts': 200 },
      },
    );
    expect(drift.map((c) => c.token)).toEqual(['src/index.ts']);
    expect(dead).toEqual([]);
  });

  it('leaves a citation alone where the document is the newer of the two', () => {
    const { drift } = run('The app is `src/index.ts`.\n', 'packages/core/README.md', PACKAGES, {
      changed: { 'packages/core/README.md': 300, 'packages/core/src/index.ts': 200 },
    });
    expect(drift).toEqual([]);
  });

  it('leaves a DIRECTORY citation off the worklist, since a directory moves whenever anything in it does', () => {
    const { drift, dead } = run('Under `src/db/`.\n', 'packages/core/README.md', PACKAGES, {
      changed: { 'packages/core/README.md': 100, 'packages/core/src/db': 200 },
    });
    expect(drift).toEqual([]);
    expect(dead).toEqual([]);
  });

  it('reports a path git keeps out of the tree as unverifiable rather than dead', () => {
    const { unverifiable, dead } = run(
      'Synced under `.claude/skills/`.\n',
      'packages/core/README.md',
      PACKAGES,
      { ignored: ['.claude/skills/'] },
    );
    expect(unverifiable.map((c) => c.token)).toEqual(['.claude/skills/']);
    expect(dead).toEqual([]);
  });

  it('reports a citation matching more than one file rather than picking one', () => {
    const tree = [
      'package.json',
      'packages/core/package.json',
      'packages/core/README.md',
      'packages/core/src/a/index.ts',
      'packages/core/src/b/index.ts',
    ];
    const { ambiguous, dead, drift } = run('One of `index.ts`.\n', 'packages/core/README.md', tree);
    expect(ambiguous.map((c) => c.hits.length)).toEqual([2]);
    expect([...dead, ...drift]).toEqual([]);
  });

  it('asks git about where a document-relative citation RESOLVES, not about the text of it', () => {
    const { unverifiable, dead } = run(
      'Written to `./generated/client.ts`.\n',
      'packages/core/README.md',
      PACKAGES,
      { ignored: ['packages/core/generated/client.ts'] },
    );
    expect(unverifiable.map((c) => c.token)).toEqual(['./generated/client.ts']);
    expect(dead).toEqual([]);
  });
});

describe('check-doc-citations — a written reason names what it excuses', () => {
  it('excuses the tokens the marker names', () => {
    const marked =
      '<!-- doc-citation: unchecked `bin/dependency-cruise.mjs` `bin/dependency-cruiser.mjs` — inside the dependency, not in this repo. -->\n' +
      'It renamed `bin/dependency-cruise.mjs` to `bin/dependency-cruiser.mjs`.\n';
    expect(measured(marked)).toEqual([]);
  });

  it('still measures a live citation sharing the paragraph with an excused one', () => {
    const mixed =
      '<!-- doc-citation: unchecked `NNNN_name.sql` — the naming template, not a file. -->\n' +
      'Write a `NNNN_name.sql`, then append to `meta/_journal.json`.\n';
    expect(measured(mixed).map((c) => c.token)).toEqual(['meta/_journal.json']);
  });

  it('refuses a marker that names no citation, rather than letting it excuse nothing in silence', () => {
    const vague = '<!-- doc-citation: unchecked — a path inside the dependency. -->\n';
    const { markerFaults } = judge(scan(vague), world(PACKAGES));
    expect(markerFaults).toHaveLength(1);
  });

  it('does not excuse a citation further down the document than the marker reaches', () => {
    const far =
      '<!-- doc-citation: unchecked `src/db/gone.ts` — covers the frame below it. -->\n\n\n\n\n' +
      'Thrown at `src/db/gone.ts`.\n';
    expect(measured(far).map((c) => c.token)).toEqual(['src/db/gone.ts']);
  });
});

describe('check-doc-citations — what it deliberately does not read', () => {
  it('reads no path inside a fenced code block', () => {
    expect(measured('```sh\ncat `src/db/gone.ts`\n```\n')).toEqual([]);
  });

  it('reads no bare extension, which names a kind of file and no file', () => {
    expect(measured('Every `.ts` and `.sql` under it.\n')).toEqual([]);
  });

  it('reads no path in another repository, which carries no extension here', () => {
    expect(measured('It lives in `plugin/skills/issue-flow`.\n')).toEqual([]);
  });

  it('reads no URL and no route', () => {
    expect(measured('Served at `/api/guides/x.md` from `https://example.com/a.ts`.\n')).toEqual([]);
  });

  it('reads no build output, which no commit carries', () => {
    expect(measured('Compiled to `dist/db/migrate.js`.\n')).toEqual([]);
  });

  it('reads no glob and no brace expansion, which name a set rather than a file', () => {
    expect(measured('Covered by `src/**/*.ts` and `db/{schema,client}.ts`.\n')).toEqual([]);
  });
});
