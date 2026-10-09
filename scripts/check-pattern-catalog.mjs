#!/usr/bin/env node

// The pattern catalog (REQ-36 BC-3, BC-4; knowledge axis): every page under the catalog directory
// names its change kind, the issue that introduced it, a reference that exists, a test shape naming a
// reference test that exists, and a numbered review checklist; the index links every page; every
// change kind the repository declares has a page; and the catalog core reads
// (`packages/contracts/src/pattern-catalog.ts`) is what the pages say. `--write` regenerates that file.
// The rules are in `scripts/lib/pattern-catalog.mjs`; module shape stays relations' (the
// core-module page points at check-module-boundaries and check-module-shape, and restates neither).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { checkerConfig } from './lib/checker-config.mjs';
import { dieAs, gitOut, ROOT } from './lib/gate.mjs';
import { judgeCatalog, selectPages } from './lib/pattern-catalog.mjs';

const die = dieAs('pattern-catalog');

const DEFAULTS = {
  dir: 'docs/patterns',
  generated: 'packages/contracts/src/pattern-catalog.ts',
  changeKinds: [],
};

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(mode))
    die('usage: check-pattern-catalog.mjs [--check|--write]');
  const cfg = checkerConfig(ROOT, 'pattern-catalog', DEFAULTS, die);
  if (!Array.isArray(cfg.changeKinds) || cfg.changeKinds.length === 0) {
    die(
      '.forge/conformance.json declares no checkers["pattern-catalog"].changeKinds, so no change kind would be held to having a pattern',
    );
  }
  let names;
  try {
    names = readdirSync(join(ROOT, cfg.dir));
  } catch (err) {
    die(`${cfg.dir}: ${err.code ?? err.message}`);
  }
  const listed = gitOut(['ls-files']);
  if (listed === null || listed.trim() === '') {
    die('`git ls-files` listed nothing, so every reference would read absent');
  }
  const tracked = new Set(listed.trim().split('\n'));
  const pages = Object.fromEntries(
    selectPages(names).map((n) => [`${cfg.dir}/${n}`, read(`${cfg.dir}/${n}`)]),
  );
  const verdict = judgeCatalog({
    dir: cfg.dir,
    pages,
    index: read(`${cfg.dir}/README.md`),
    tracked,
    kinds: cfg.changeKinds,
    generated: read(cfg.generated),
    generatedRel: cfg.generated,
  });
  if (verdict.code === 2) die(verdict.reason);

  if (mode === '--write') {
    const pageFaults = verdict.violations.filter((v) => !v.includes('PATTERN_CATALOG_STALE'));
    if (pageFaults.length > 0) {
      for (const v of pageFaults) console.error(v);
      console.error(
        '\npattern-catalog: nothing written — a catalog is generated only from pages that pass',
      );
      return 1;
    }
    writeFileSync(join(ROOT, cfg.generated), verdict.expected);
    console.log(`pattern-catalog: wrote ${cfg.generated} from ${verdict.scanned} page(s)`);
    return 0;
  }

  if (verdict.code === 1) {
    for (const v of verdict.violations) console.error(v);
    console.error(
      // The count leads in the shape the passing line has, so `pnpm verify` reads a red as a red
      // that ran, never as a checker it cannot prove ran.
      `\npattern-catalog: ${verdict.scanned} entr(y/ies) scanned, ${verdict.violations.length} violation(s)`,
    );
    console.error(
      `Each page under ${cfg.dir}/ opens with \`# <Title>\`, \`**Change kind:**\` and \`**Introduced by:** <ISSUE-n>\`,\n` +
        'then `## Reference` (tracked files), `## Test shape` (a tracked reference test) and `## Review checklist`\n' +
        '(numbered lines). The shape and the new-pattern approval are in docs/patterns/README.md.',
    );
    return 1;
  }
  console.log(
    `pattern-catalog: ${verdict.scanned} entr(y/ies) scanned, each naming a reference, a test shape and a review checklist that exist`,
  );
  return 0;
}

process.exit(main());
