#!/usr/bin/env node

// Language axis: no web copy string is long (REQ-43 BC-1, BC-2). Every English string in the copy
// files — packages/web-v2/src/**/copy*.json and lib/i18n/copy/** — is at most `budget` words, a
// refusal or confirmation at most `refusalBudget`. What is over today is frozen in a baseline that
// only shrinks; `--trim` rewrites it downward and refuses to write one that holds more, and
// `--freeze` writes the first one, refusing where one already exists.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { checkerConfig } from './lib/checker-config.mjs';
import { baselineOf, faults, frozen, overBudget } from './lib/copy-budget.mjs';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';

const die = dieAs('copy-budget');
const DEFAULTS = {
  scanRoot: 'packages/web-v2/src',
  copyDirs: ['packages/web-v2/src/lib/i18n/copy'],
  budget: 12,
  refusalBudget: 20,
  refusalSegments: '^$',
  baseline: '.forge/copy-budget-baseline.json',
};
const CFG = checkerConfig(ROOT, 'copy-budget', DEFAULTS, die);
const refusalSegments = new RegExp(CFG.refusalSegments);

const inCopyDir = (path) => CFG.copyDirs.some((dir) => path.startsWith(`${dir}/`));
const files = walkFiles(CFG.scanRoot, {
  skipDirs: ['node_modules', '.next'],
  keep: (path, name) =>
    name.endsWith('.json') && (/^copy[^/]*\.json$/.test(name) || inCopyDir(path)),
}).sort();
if (files.length === 0)
  die(`no copy file under ${CFG.scanRoot}: the scan read nothing, which is not a pass`);

const entries = [];
for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  } catch (err) {
    die(`${file} is not valid JSON: ${err.message}`);
  }
  for (const [key, text] of Object.entries(doc.en ?? {})) {
    if (typeof text !== 'string') die(`${file} · ${key}: an English copy value must be a string`);
    entries.push({ file, key, text });
  }
}

const over = overBudget(entries, { ...CFG, refusalSegments });
const path = join(ROOT, CFG.baseline);
let baseline;
try {
  baseline = existsSync(path) ? frozen(JSON.parse(readFileSync(path, 'utf8'))) : new Map();
} catch (err) {
  die(`${CFG.baseline} is not valid JSON: ${err.message}`);
}

if (process.argv.includes('--freeze')) {
  if (existsSync(path)) {
    console.error(
      `copy-budget: ${CFG.baseline} exists; --freeze writes the first baseline only, --trim shrinks it`,
    );
    process.exit(1);
  }
  writeFileSync(path, `${JSON.stringify(baselineOf(over), null, 2)}\n`);
  console.log(`copy-budget: baseline frozen at ${over.size} string(s)`);
  process.exit(0);
}

if (process.argv.includes('--trim')) {
  if (!existsSync(path)) {
    console.error(`copy-budget: no ${CFG.baseline} to trim; --freeze writes the first one`);
    process.exit(1);
  }
  const refused = faults(over, baseline).filter((f) => /new string|grew from/.test(f));
  if (refused.length > 0) {
    console.error(
      `copy-budget: --trim only shrinks the baseline; refused:\n  ${refused.join('\n  ')}`,
    );
    process.exit(1);
  }
  writeFileSync(path, `${JSON.stringify(baselineOf(over), null, 2)}\n`);
  console.log(`copy-budget: baseline trimmed to ${over.size} string(s)`);
  process.exit(0);
}

const found = faults(over, baseline);
console.log(
  `copy-budget: ${entries.length} string(s) in ${files.length} file(s) read, ${over.size} over budget (${baseline.size} frozen)`,
);
if (found.length === 0) process.exit(0);
console.error(
  `\ncopy-budget: ${found.length} refusal(s) — at most ${CFG.budget} words, ${CFG.refusalBudget} for a refusal or confirmation:\n  ${found.slice(0, 40).join('\n  ')}${found.length > 40 ? `\n  (+${found.length - 40} more)` : ''}\n`,
);
process.exit(1);
