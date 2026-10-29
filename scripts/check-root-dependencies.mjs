#!/usr/bin/env node
// A root consumer may reach only what the manifest it stands under declares (ISS-140). The rule and
// its bounds are scripts/lib/root-dependencies.mjs; this reads the tree, prints and exits.
// Exit 0 clean · 1 an undeclared use, or an allowance that covers nothing · 2 could not run.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readManifest } from './lib/checker-config.mjs';
import { dieAs, gitOut, ROOT } from './lib/gate.mjs';
import {
  allowanceFaults,
  declaredNames,
  judge,
  pathMapUses,
  providedBins,
  sourceUses,
  undeclared,
} from './lib/root-dependencies.mjs';

const die = dieAs('root-dependencies');
const SOURCE = /\.(?:[cm]?js|[cm]?ts)$/;

const { manifest, error } = readManifest(ROOT);
if (error) die(error);
const cfg = manifest?.checkers?.['root-dependencies'];
if (!cfg) die('.forge/conformance.json declares no checkers["root-dependencies"] block');
if (!Array.isArray(cfg.scan) || cfg.scan.length === 0) {
  die('checkers["root-dependencies"].scan is empty — no root consumer would be read');
}
const faults = allowanceFaults(cfg.allowed);
if (faults.length > 0) die(`checkers["root-dependencies"]:\n  ${faults.join('\n  ')}`);

const listed = gitOut(['ls-files', '-z', '--', ...cfg.scan]);
if (listed === null) die(`git ls-files failed over ${cfg.scan.join(', ')}`);
const files = listed.split('\0').filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts'));
if (files.length === 0) die(`no source file is tracked under ${cfg.scan.join(', ')}`);

/** The nearest package.json at or above `file`, inside this checkout and never above it. */
function manifestFor(file) {
  let dir = dirname(file);
  for (;;) {
    const rel = dir === '.' ? 'package.json' : `${dir}/package.json`;
    if (existsSync(join(ROOT, rel))) return dir === '.' ? '' : dir;
    if (dir === '.') return null;
    dir = dirname(dir);
  }
}

const manifests = new Map();
function manifestAt(dir) {
  if (manifests.has(dir)) return manifests.get(dir);
  const rel = dir ? `${dir}/package.json` : 'package.json';
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch (err) {
    die(`${rel} could not be read as JSON: ${err.message}`);
  }
  const declared = declaredNames(pkg);
  let bins = null;
  const entry = {
    rel,
    declared,
    bins: () => {
      if (bins) return bins;
      const modules = join(ROOT, dir, 'node_modules');
      if (!existsSync(modules)) {
        die(
          `a root consumer runs a bin, and ${dir || '.'}/node_modules is absent, so no declared ` +
            'package can be read for the bins it provides — run: pnpm install --frozen-lockfile',
        );
      }
      bins = providedBins(declared, (name) => {
        const path = join(modules, name, 'package.json');
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      });
      return bins;
    },
  };
  manifests.set(dir, entry);
  return entry;
}

const findings = [];
const notes = [];
let useCount = 0;
function judgeUses(file, uses) {
  const dir = manifestFor(file);
  if (dir === null) die(`${file} stands under no package.json in this checkout`);
  const m = manifestAt(dir);
  for (const use of uses) {
    useCount++;
    const miss = undeclared(use, m.declared, use.bin ? m.bins() : null);
    if (miss) findings.push({ file, manifest: m.rel, ...miss });
  }
}

for (const file of files) {
  const { uses, notes: n } = sourceUses(file, readFileSync(join(ROOT, file), 'utf8'));
  judgeUses(file, uses);
  for (const x of n) notes.push(`${file}:${x.line} ${x.text}`);
}
for (const map of cfg.pathMaps ?? []) {
  if (!existsSync(join(ROOT, map))) die(`pathMaps names ${map}, which is not in this checkout`);
  let uses;
  try {
    uses = pathMapUses(readFileSync(join(ROOT, map), 'utf8'));
  } catch (err) {
    die(`${map} could not be read as JSON: ${err.message}`);
  }
  judgeUses(map, uses);
}

const { refused, excused, stale } = judge(findings, cfg.allowed ?? []);
const what = (u) => (u.package ? `package \`${u.package}\`` : `bin \`${u.bin}\``);

console.log(
  `root-dependencies: ${files.length + (cfg.pathMaps ?? []).length} file(s) read, ` +
    `${useCount} package or bin use(s), ${excused.length} allowed`,
);
for (const e of excused) console.log(`  allowed: ${e.file}:${e.line} ${e.how} ${what(e)}`);
for (const n of notes) console.log(`  not read: ${n}`);

if (refused.length === 0 && stale.length === 0) process.exit(0);

for (const f of refused) {
  const gap = f.package
    ? `which ${f.manifest} does not declare`
    : `which no package ${f.manifest} declares provides`;
  console.error(`  ${f.file}:${f.line}  ${f.how} ${what(f)}, ${gap}`);
}
for (const a of stale) {
  console.error(
    `  stale allowance: ${a.consumer} -> ${a.package ?? a.bin} covers no use — remove it from ` +
      'checkers["root-dependencies"].allowed',
  );
}
console.error(
  '\nA root consumer reaches a package only its own manifest may vouch for. The hoisted root\n' +
    'node_modules makes the undeclared one resolve today and nothing else says so. Declare it in\n' +
    'the manifest named above, or add an allowance with why, $costs and endsWhen.',
);
process.exit(1);
