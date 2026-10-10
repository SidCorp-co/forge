#!/usr/bin/env node

// Language axis: no web copy string is long, explains, or pads an empty state (REQ-43 BC-1, BC-2,
// BC-4, BC-6). Every English string in the copy files — packages/web-v2/src/**/copy*.json and
// lib/i18n/copy/** — is at most `budget` words, a refusal or confirmation at most `refusalBudget`,
// an empty state at most `emptyBudget`, and a string whose key names an explanation is refused at
// any length. What a key is comes from the segment conventions `.forge/conformance.json` declares;
// a convention it does not declare stops the check, since reading nothing as an explanation would
// pass every page.
//
// What core says (`saidKeys`, the contracts registry of sentence templates, REQ-43 BC-11) holds the
// same word budgets, a refusal or confirmation by the same segments; its keys name a sentence, never
// a screen's empty state or explanation, so those two kinds are web copy's alone.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { checkerConfig } from './lib/checker-config.mjs';
import { faults, overBudget } from './lib/copy-budget.mjs';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';

const die = dieAs('copy-budget');
const DEFAULTS = {
  scanRoot: 'packages/web-v2/src',
  copyDirs: ['packages/web-v2/src/lib/i18n/copy'],
  budget: 12,
  refusalBudget: 20,
  emptyBudget: 2,
  saidKeys: 'packages/contracts/src/said-keys.ts',
};
const CFG = checkerConfig(ROOT, 'copy-budget', DEFAULTS, die);
const segments = {};
for (const name of ['refusalSegments', 'emptySegments', 'explainSegments']) {
  if (typeof CFG[name] !== 'string' || CFG[name] === '')
    die(
      `.forge/conformance.json checkers.copy-budget declares no ${name}: a key's kind cannot be read`,
    );
  try {
    segments[name] = new RegExp(CFG[name]);
  } catch (err) {
    die(`checkers.copy-budget.${name} is not a valid pattern: ${err.message}`);
  }
}
if ('baseline' in CFG)
  die(
    'checkers.copy-budget declares a baseline; the copy budget holds every string and carries none',
  );

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
const said = [];
readFileSync(join(ROOT, CFG.saidKeys), 'utf8')
  .split('\n')
  .forEach((line, i) => {
    if (!/\ben:\s*"/.test(line)) return;
    const m = SAID_LINE.exec(line);
    if (!m)
      die(
        `${CFG.saidKeys}:${i + 1}: an entry this gate cannot read; keep one \`"key": { en: "…" }\` per line`,
      );
    said.push({ file: CFG.saidKeys, key: m[1], text: JSON.parse(m[2]) });
  });
if (said.length === 0)
  die(`${CFG.saidKeys} gave no English template: the scan read nothing, which is not a pass`);
const NEVER = /(?!)/;

const found = [
  ...faults(overBudget(entries, { ...CFG, ...segments })),
  ...faults(
    overBudget(said, { ...CFG, ...segments, emptySegments: NEVER, explainSegments: NEVER }),
  ),
];
console.log(
  `copy-budget: ${entries.length + said.length} string(s) in ${files.length + 1} file(s) read, ${found.length} over budget`,
);
if (found.length === 0) process.exit(0);
console.error(
  `\ncopy-budget: ${found.length} refusal(s) — at most ${CFG.budget} words, ${CFG.refusalBudget} for a refusal or confirmation, ${CFG.emptyBudget} for an empty state, none that explains:\n  ${found.slice(0, 40).join('\n  ')}${found.length > 40 ? `\n  (+${found.length - 40} more)` : ''}\n`,
);
process.exit(1);
