#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { judge, listProposals } from './lib/honest-costs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VISION = 'docs/VISION.md';
const PROPOSALS = 'docs/proposals';

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function proposals() {
  let found;
  try {
    found = listProposals(resolve(ROOT, PROPOSALS));
  } catch (err) {
    return { error: `${PROPOSALS}: ${err.message}` };
  }
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
        `choices it makes, not the boundaries it draws. The convention is in docs/README.md.`,
    );
    return 1;
  }
  console.log(`honest-costs: ${verdict.scanned} document(s) price what choosing them costs`);
  return 0;
}

process.exit(main());
