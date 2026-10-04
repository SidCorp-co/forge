#!/usr/bin/env node
// Pattern v2's small module script (docs/conventions/domain-entities.md, ADR 0008). It refuses a
// declaration that contradicts itself (packages/core/src/modules.json: a table owned twice, `owns`
// on a kind that owns nothing, a module with no known context) and reports, per core module, the
// semantic rules no import graph shows: undeclared directories, writes to a table another module
// owns, database calls in route files and refusals outside the envelope. A status written outside
// the kernel transition is refused by the database (`forge_kernel_status_guard`), not reported here.
// The import rules are scripts/check-module-boundaries.mjs's.
//
// The semantic report is regex over source and runs on demand for the orchestrator or QA. It exits
// 0 with its findings, 1 on a refused declaration, 2 when it cannot run; --markers writes the
// findings as the reconciliation Wrong markers.
//
//   node scripts/check-module-shape.mjs [--markers <file>]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredTables,
  isTestFile,
  kindFindings,
  kindOf,
  markers,
  moduleOf,
  parseDeclaration,
  RULES,
  refusalFindings,
  routeQueryFindings,
  tableWriterFindings,
  tableWrites,
  tally,
  totals,
} from './lib/module-shape.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages/core/src');

function die(message) {
  console.error(`module-shape: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) die(`${name} needs a path`);
  return v;
};
const known = new Set(['--markers']);
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !known.has(a))
    die(`unknown flag ${a} — one of ${[...known].join(', ')}`);
  if (!a.startsWith('--') && args[i - 1] !== '--markers') die(`unexpected argument ${a}`);
}

const DECLARATION = 'packages/core/src/modules.json';
let declaration;
try {
  declaration = JSON.parse(readFileSync(join(ROOT, DECLARATION), 'utf8'));
} catch (err) {
  die(`${DECLARATION} is unreadable: ${err.message}`);
}
const { faults, modules, owners } = parseDeclaration(declaration);
if (faults.length) {
  console.error(`module-shape: ${DECLARATION} is refused:\n  ${faults.join('\n  ')}`);
  process.exit(1);
}
for (const path of Object.keys(modules)) {
  if (path === '(root)') continue;
  if (!existsSync(join(SRC, path)))
    die(`${DECLARATION} declares ${path}, which has no directory under packages/core/src`);
}

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts')) out.push(relative(ROOT, p));
  }
  return out;
}

const files = sourceFiles(SRC).filter((f) => !isTestFile(f));
const dirs = readdirSync(SRC).filter((d) => statSync(join(SRC, d)).isDirectory());

const texts = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const schema = files.filter((f) => /packages\/core\/src\/db\/schema[^/]*\.ts$/.test(f));
const tables = declaredTables(schema.map((f) => texts.get(f)));

const findings = [...kindFindings(dirs, modules)];

const writes = [];
for (const [file, text] of texts) {
  const mod = moduleOf(file, modules);
  const kind = kindOf(mod, modules);
  if (!schema.includes(file))
    for (const w of tableWrites(text, tables)) writes.push({ ...w, file, module: mod });
  findings.push(...routeQueryFindings(file, text, mod));
  findings.push(...refusalFindings(file, text, mod, kind));
}
const { findings: writerHits, multiWriter } = tableWriterFindings(writes, owners);
findings.push(...writerHits);
const undeclared = [...tables.keys()].filter((t) => !owners.has(t));

const byModule = tally(findings, modules, dirs);
const sum = totals(byModule);
const sha =
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || null;

const markersPath = flag('--markers');
if (markersPath) {
  writeFileSync(
    markersPath,
    `${JSON.stringify(markers(byModule, { atSha: sha, multiWriter }), null, 1)}\n`,
  );
}

const wrong = Object.entries(byModule).filter(([, r]) => RULES.some((k) => r.counts[k] > 0));
console.log(
  `module-shape: ${files.length} file(s) scanned across ${Object.keys(byModule).length} module(s), ${tables.size} table(s)`,
);
console.log(`module-shape: ${RULES.map((r) => `${r} ${sum[r]}`).join(' · ')}`);
console.log(
  `module-shape: ${wrong.length} module(s) Wrong, ${wrong.filter(([, r]) => RULES.filter((k) => r.counts[k] > 0).length >= 2).length} due for rewrite (two or more rules); ${Object.keys(multiWriter).length} table(s) written from more than one module`,
);
if (undeclared.length)
  console.log(
    `module-shape: ${undeclared.length} table(s) declare no owner: ${undeclared.join(', ')}`,
  );
const width = Math.max(...wrong.map(([m]) => m.length), 6);
console.log(
  `\n  ${'module'.padEnd(width)}  ${'kind'.padEnd(10)}  ${RULES.map((r) => r.padStart(Math.max(r.length, 4))).join(' ')}`,
);
for (const [m, r] of wrong.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    `  ${m.padEnd(width)}  ${String(r.kind).padEnd(10)}  ${RULES.map((k) => String(r.counts[k]).padStart(Math.max(k.length, 4))).join(' ')}`,
  );
}
if (!markersPath) console.log('\nmodule-shape: --markers <file> writes these as Wrong markers');
