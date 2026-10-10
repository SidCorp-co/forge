#!/usr/bin/env node

// Language axis: no copy string is long (REQ-43 BC-1, BC-2, BC-11). Every English string in the copy
// files — packages/web-v2/src/**/copy*.json and lib/i18n/copy/** — and every English template core
// says (`saidKeys`, the contracts registry) is at most `budget` words, a refusal or confirmation at
// most `refusalBudget`. No string is frozen: the baseline the gate landed with emptied (ISS-496's
// copy lanes), so every string over budget is refused by file, key and word count.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { checkerConfig } from './lib/checker-config.mjs';
import { overBudget } from './lib/copy-budget.mjs';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';

const die = dieAs('copy-budget');
const DEFAULTS = {
  scanRoot: 'packages/web-v2/src',
  copyDirs: ['packages/web-v2/src/lib/i18n/copy'],
  budget: 12,
  refusalBudget: 20,
  refusalSegments: '^$',
  saidKeys: 'packages/contracts/src/said-keys.ts',
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

// What core says: one `"key": { en: "…", … }` entry per line. A line naming `en:` that this reading
// cannot parse is refused, never skipped, so a reformat cannot drop the registry out of the gate.
const SAID_LINE = /^\s*"([^"]+)":\s*\{\s*en:\s*("(?:[^"\\]|\\.)*")/;
const saidSource = readFileSync(join(ROOT, CFG.saidKeys), 'utf8').split('\n');
let saidRead = 0;
saidSource.forEach((line, i) => {
  if (!/\ben:\s*"/.test(line)) return;
  const m = SAID_LINE.exec(line);
  if (!m)
    die(
      `${CFG.saidKeys}:${i + 1}: an entry this gate cannot read; keep one \`"key": { en: "…" }\` per line`,
    );
  entries.push({ file: CFG.saidKeys, key: m[1], text: JSON.parse(m[2]) });
  saidRead += 1;
});
if (saidRead === 0)
  die(`${CFG.saidKeys} gave no English template: the scan read nothing, which is not a pass`);

const over = overBudget(entries, { ...CFG, refusalSegments });
console.log(
  `copy-budget: ${entries.length} string(s) in ${files.length + 1} file(s) read, ${over.size} over budget`,
);
if (over.size === 0) process.exit(0);
const found = [...over.values()].map(
  (o) => `${o.file} · ${o.key}: ${o.words} words, budget ${o.budget}`,
);
console.error(
  `\ncopy-budget: ${found.length} refusal(s) — at most ${CFG.budget} words, ${CFG.refusalBudget} for a refusal or confirmation:\n  ${found.slice(0, 40).join('\n  ')}${found.length > 40 ? `\n  (+${found.length - 40} more)` : ''}\n`,
);
process.exit(1);
