#!/usr/bin/env node
// Relations axis (ISS-1254): test code keeps no hand-kept list of what a registry registers — route
// paths, MCP doors, timers, report queries, outbox events, guides, core modules. The registries and
// the priced allowances are `.forge/conformance.json` `checkers["hand-kept-inventories"]`; the rule
// is scripts/lib/hand-kept-inventories.mjs. This reads the tree, prints and exits.
// Exit 0 clean · 1 a hand-kept list, or an allowance that covers none · 2 could not run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from './lib/checker-config.mjs';
import { dieAs, gitOut, ROOT } from './lib/gate.mjs';
import {
  allowanceFaults,
  findInventories,
  judge,
  readRegistry,
} from './lib/hand-kept-inventories.mjs';

const die = dieAs('hand-kept-inventories');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const { manifest, error } = readManifest(ROOT);
if (error) die(error);
const cfg = manifest?.checkers?.['hand-kept-inventories'];
if (!cfg) die('.forge/conformance.json declares no checkers["hand-kept-inventories"] block');
if (!Array.isArray(cfg.scan) || cfg.scan.length === 0)
  die('checkers["hand-kept-inventories"].scan is empty');
if (typeof cfg.testCode !== 'string')
  die('checkers["hand-kept-inventories"].testCode names no pattern');
if (!Array.isArray(cfg.registries) || cfg.registries.length === 0) die('no registry is declared');
const testCode = new RegExp(cfg.testCode);

const tracked = (spec) => {
  const out = gitOut(['ls-files', '-z', '--', spec]);
  if (out === null) die(`git ls-files failed over ${spec}`);
  return out.split('\0').filter(Boolean);
};
const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch (err) {
    return die(`could not read ${rel}: ${err.message}`);
  }
};

const registries = [];
const registrySources = new Set();
for (const spec of cfg.registries) {
  const files = tracked(spec.source).filter((f) => !testCode.test(f));
  if (files.length === 0) die(`registry "${spec.name}": no tracked file matches ${spec.source}`);
  for (const f of files) registrySources.add(f);
  const reg = readRegistry(
    spec,
    files.map((f) => [f, read(f)]),
  );
  if (reg.unreadable) die(reg.unreadable);
  registries.push({ ...spec, min: spec.min ?? cfg.min ?? 4, names: reg.names });
}

const faults = allowanceFaults(
  cfg.allowed,
  registries.map((r) => r.name),
);
if (faults.length > 0) die(`checkers["hand-kept-inventories"]:\n  ${faults.join('\n  ')}`);

const files = cfg.scan
  .flatMap(tracked)
  .filter(
    (f) => SOURCE.test(f) && !f.endsWith('.d.ts') && testCode.test(f) && !registrySources.has(f),
  );
if (files.length === 0) die(`no test file is tracked under ${cfg.scan.join(', ')}`);

const findings = files.flatMap((file) =>
  findInventories(file, read(file), registries).map((f) => ({ file, ...f })),
);
const { refused, excused } = judge(findings, registries, cfg.allowed ?? []);

console.log(
  `hand-kept-inventories: ${files.length} file(s) read against ${registries
    .map((r) => `${r.names.size} ${r.name}`)
    .join(', ')}; ${excused} list(s) allowed`,
);
if (refused.length === 0) process.exit(0);
for (const r of refused) console.error(`  ${r}`);
console.error(
  `\nhand-kept-inventories: ${refused.length} refusal(s). A list that only restates a registry is read from it; ` +
    'one that is a reviewed claim of its own is allowed in .forge/conformance.json with why and endsWhen.',
);
process.exit(1);
