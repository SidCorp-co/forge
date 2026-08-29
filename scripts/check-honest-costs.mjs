#!/usr/bin/env node
// Every document that asks a reader to adopt something must say what adopting
// it costs them.
//
// `docs/VISION.md` had a Boundaries section — what Forge will not become — and
// nothing that priced what choosing Forge takes from whoever chooses it. The
// root CLAUDE.md publishes "a trade-off is priced or it is not taken" while the
// constitution took its own trade-offs unpriced, and every proposal in the tree
// did the same. A convention nobody checks is the convention that produced that
// gap, so the rule arrives with something that complains.
//
// Scope: docs/VISION.md and every proposal under docs/proposals/. `README.md`
// there is the index — it carries the rule, not a price of its own — and the
// `.html` files are drawn figures, which hold no markdown heading tree to check.
//
// Exit codes: 0 clean, 1 violations found, 2 could not run.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { judge } from './lib/honest-costs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VISION = 'docs/VISION.md';
const PROPOSALS = 'docs/proposals';
const INDEX = 'README.md';

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function proposals() {
  let entries;
  try {
    entries = readdirSync(resolve(ROOT, PROPOSALS));
  } catch (err) {
    return { error: `${PROPOSALS}: ${err.message}` };
  }
  const found = entries.filter((n) => n.endsWith('.md') && n !== INDEX);
  if (found.length === 0) return { error: `${PROPOSALS}: no proposal found — is the path right?` };
  return { found: found.map((n) => `${PROPOSALS}/${n}`) };
}

function main() {
  const { found, error } = proposals();
  if (error) {
    console.error(`honest-costs: could not run — ${error}`);
    return 2;
  }
  const documents = Object.fromEntries([VISION, ...found].map((rel) => [rel, read(rel)]));

  const verdict = judge(documents);
  if (verdict.code === 2) {
    console.error(`honest-costs: could not run — ${verdict.reason}`);
    return 2;
  }
  if (verdict.code === 1) {
    for (const v of verdict.violations) console.error(v);
    console.error(
      `\nhonest-costs: ${verdict.violations.length} violation(s) across ${verdict.scanned} document(s)`,
    );
    console.error(
      `Add a \`## Honest costs\` section saying what this takes from whoever adopts it — the price of the\n` +
        `choices it makes, not the boundaries it draws. The convention is in ${PROPOSALS}/${INDEX}.`,
    );
    return 1;
  }
  console.log(`honest-costs: ${verdict.scanned} document(s) price what choosing them costs`);
  return 0;
}

process.exit(main());
