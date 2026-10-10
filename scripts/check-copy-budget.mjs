#!/usr/bin/env node

// Language axis: no web copy string is long, explains, or pads an empty state (REQ-43 BC-1, BC-2,
// BC-4, BC-6), neither is a sentence core writes for a page (BC-11), and no component writes its
// English inline, where none of this could read it. Every English string in the
// copy files — packages/web-v2/src/**/copy*.json and lib/i18n/copy/** — and every English template
// of the sentence registries `sentences` names is at most `budget` words, a refusal or confirmation
// at most `refusalBudget`, an empty state at most `emptyBudget`, and a string whose key names an
// explanation is refused at any length. What a key is comes from the segment conventions
// `.forge/conformance.json` declares; a convention it does not declare stops the check, since reading
// nothing as an explanation would pass every page.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { checkerConfig } from './lib/checker-config.mjs';
import { faults, inlineCopyOf, inlineFaults, overBudget, sentencesOf } from './lib/copy-budget.mjs';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';

const die = dieAs('copy-budget');
const DEFAULTS = {
  scanRoot: 'packages/web-v2/src',
  copyDirs: ['packages/web-v2/src/lib/i18n/copy'],
  budget: 12,
  refusalBudget: 20,
  emptyBudget: 2,
};
const CFG = checkerConfig(ROOT, 'copy-budget', DEFAULTS, die);
const pattern = (where, value) => {
  if (typeof value !== 'string' || value === '')
    die(`.forge/conformance.json ${where} is not declared: a key's kind cannot be read`);
  try {
    return new RegExp(value);
  } catch (err) {
    die(`${where} is not a valid pattern: ${err.message}`);
  }
};
const segments = {};
for (const name of ['refusalSegments', 'emptySegments', 'explainSegments'])
  segments[name] = pattern(`checkers.copy-budget.${name}`, CFG[name]);
if (!Array.isArray(CFG.sentences) || CFG.sentences.length === 0)
  die(
    'checkers.copy-budget declares no sentences: the sentences core writes for pages would go unread',
  );
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

const over = overBudget(entries, { ...CFG, ...segments });

// A registry's own `emptySegments` replaces the copy files' one for its keys: core names a sentence
// by the reason it gives (`noRunner`, `noToken`), so `no<X>` there is a reason, not an empty state.
let sentences = 0;
for (const [i, registry] of CFG.sentences.entries()) {
  const where = `checkers.copy-budget.sentences[${i}]`;
  if (typeof registry?.file !== 'string' || typeof registry?.symbol !== 'string')
    die(`${where} must name a \`file\` and the \`symbol\` of its registry`);
  if (!existsSync(join(ROOT, registry.file)))
    die(`${where}.file ${registry.file} does not exist: its sentences would go unread`);
  let read;
  try {
    read = sentencesOf(
      readFileSync(join(ROOT, registry.file), 'utf8'),
      registry.file,
      registry.symbol,
    );
  } catch (err) {
    die(err.message);
  }
  const own = { ...segments };
  if ('emptySegments' in registry)
    own.emptySegments = pattern(`${where}.emptySegments`, registry.emptySegments);
  for (const [k, v] of overBudget(read, { ...CFG, ...own })) over.set(k, v);
  sentences += read.length;
}

// Copy a component writes inline is copy the budget above cannot read, so none is allowed: a person-
// facing English string in a `.tsx` or `.ts` under the scan root lives in its feature's copy file. A test file
// and the test fixtures are not pages; `inline.skip` names the directories REQ-43 scopes out.
const inline = CFG.inline;
if (!inline || typeof inline !== 'object')
  die('checkers.copy-budget declares no `inline`: copy written inside a component would go unread');
const attributes = pattern('checkers.copy-budget.inline.attributes', inline.attributes);
if (!Array.isArray(inline.skip))
  die('checkers.copy-budget.inline.skip must be a list of { dir, why }');
for (const [i, entry] of inline.skip.entries()) {
  if (typeof entry?.dir !== 'string' || typeof entry?.why !== 'string' || entry.why === '')
    die(`checkers.copy-budget.inline.skip[${i}] must name a \`dir\` and \`why\` it is not a page`);
  if (!existsSync(join(ROOT, entry.dir)))
    die(`checkers.copy-budget.inline.skip[${i}] names ${entry.dir}, which does not exist: drop it`);
}
const skipped = (path) =>
  inline.skip.some(({ dir }) => path.startsWith(`${dir}/`)) || /\.test\.tsx?$/.test(path);
const components = walkFiles(CFG.scanRoot, {
  skipDirs: ['node_modules', '.next'],
  keep: (path, name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !skipped(path),
}).sort();
if (components.length === 0)
  die(`no source file under ${CFG.scanRoot}: the inline scan read nothing, which is not a pass`);
const written = components.flatMap((file) =>
  inlineCopyOf(readFileSync(join(ROOT, file), 'utf8'), file, attributes),
);

const found = [...faults(over), ...inlineFaults(written)];
console.log(
  `copy-budget: ${entries.length} string(s) in ${files.length} file(s), ${sentences} sentence(s) in ${CFG.sentences.length} registry file(s) and ${components.length} source file(s) read, ${over.size} over budget, ${written.length} written inline`,
);
if (found.length === 0) process.exit(0);
console.error(
  `\ncopy-budget: ${found.length} refusal(s) — at most ${CFG.budget} words, ${CFG.refusalBudget} for a refusal or confirmation, ${CFG.emptyBudget} for an empty state, none that explains, none written inline:\n  ${found.slice(0, 40).join('\n  ')}${found.length > 40 ? `\n  (+${found.length - 40} more)` : ''}\n`,
);
process.exit(1);
