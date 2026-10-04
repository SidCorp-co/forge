#!/usr/bin/env node
// Pattern v2's module checker (docs/conventions/domain-entities.md, ADR 0008). Reports, per core
// module: its kind, imports against the dependency direction, imports of another module's
// internals, import cycles, writes to a table another module owns, database calls in route files,
// refusals outside the envelope, and status writes outside the kernel transition.
//
// The import graph is archmap's (`archmap graph --json`), so one resolver answers for both checks.
// Report-only while `.forge/conformance.json` checkers["module-shape"].mode is "report": it exits 0
// with findings, 1 only in "gate" mode when a count rises above the frozen baseline, 2 when it
// cannot run.
//
//   node scripts/check-module-shape.mjs [--graph <file>] [--markers <file>] [--update-baseline]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineOf,
  compareBaseline,
  cycleFindings,
  declaredTables,
  directionFindings,
  isTestFile,
  kindFindings,
  kindOf,
  markers,
  moduleOf,
  parseDeclaration,
  publicFaceFindings,
  RULES,
  refusalFindings,
  routeQueryFindings,
  statusWriteFindings,
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
const known = new Set(['--graph', '--markers', '--update-baseline']);
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !known.has(a))
    die(`unknown flag ${a} — one of ${[...known].join(', ')}`);
  if (!a.startsWith('--') && !['--graph', '--markers'].includes(args[i - 1]))
    die(`unexpected argument ${a}`);
}

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, '.forge/conformance.json'), 'utf8')).checkers?.[
    'module-shape'
  ];
} catch (err) {
  die(`.forge/conformance.json is unreadable: ${err.message}`);
}
if (!config)
  die(
    '.forge/conformance.json declares no checkers["module-shape"] — nothing says where the declaration and baseline live',
  );
if (!['report', 'gate'].includes(config.mode))
  die(`checkers["module-shape"].mode is ${JSON.stringify(config.mode)}, not "report" or "gate"`);

let declaration;
try {
  declaration = JSON.parse(readFileSync(join(ROOT, config.declaration), 'utf8'));
} catch (err) {
  die(`${config.declaration} is unreadable: ${err.message}`);
}
const { faults, modules, owners } = parseDeclaration(declaration);
if (faults.length) die(`the declaration is refused:\n  ${faults.join('\n  ')}`);
for (const path of Object.keys(modules)) {
  if (path === '(root)') continue;
  if (!existsSync(join(SRC, path)))
    die(`${config.declaration} declares ${path}, which has no directory under packages/core/src`);
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

function graph() {
  const path = flag('--graph');
  if (path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      die(`--graph ${path} is unreadable: ${err.message}`);
    }
  }
  const r = spawnSync(join(ROOT, '.forge/archmap/archmap'), ['graph', '--json', '--compact'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    die(
      `archmap graph could not run (${r.error?.message ?? `exit ${r.status}`}): ${(r.stderr ?? '').trim().split('\n').pop()}`,
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    die('archmap graph printed no JSON document');
  }
}

const g = graph();
if (g.formatVersion !== 1)
  die(`archmap graph formatVersion ${g.formatVersion}; this checker reads 1`);
if (!g.complete)
  die(
    'archmap graph is incomplete — a provider did not run, so an absent edge would read as a clean one',
  );
const edges = g.edges.filter((e) => e.resolved && e.fromFile?.startsWith('packages/core/src/'));

const texts = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const schema = files.filter((f) => /packages\/core\/src\/db\/schema[^/]*\.ts$/.test(f));
const tables = declaredTables(schema.map((f) => texts.get(f)));

const findings = [
  ...kindFindings(dirs, modules),
  ...directionFindings(edges, modules),
  ...publicFaceFindings(edges, modules),
];
const { findings: cycleHits, cycles } = cycleFindings(edges, modules);
findings.push(...cycleHits);

const writes = [];
for (const [file, text] of texts) {
  const mod = moduleOf(file, modules);
  const kind = kindOf(mod, modules);
  if (!schema.includes(file))
    for (const w of tableWrites(text, tables)) writes.push({ ...w, file, module: mod });
  findings.push(...routeQueryFindings(file, text, mod));
  findings.push(...refusalFindings(file, text, mod, kind));
  findings.push(...statusWriteFindings(file, text, mod));
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
    `${JSON.stringify(markers(byModule, { atSha: sha, cycles, multiWriter }), null, 1)}\n`,
  );
}

const baselinePath = join(ROOT, config.baseline);
if (args.includes('--update-baseline')) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineOf(byModule), null, 2)}\n`);
}
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch {
  die(
    `${config.baseline} is unreadable — run with --update-baseline once to freeze today's findings`,
  );
}
const { rose, fell } = compareBaseline(byModule, baseline);

const wrong = Object.entries(byModule).filter(([, r]) => RULES.some((k) => r.counts[k] > 0));
console.log(
  `module-shape: ${files.length} file(s) scanned across ${Object.keys(byModule).length} module(s), ${edges.length} import edge(s), ${tables.size} table(s)`,
);
console.log(`module-shape: ${RULES.map((r) => `${r} ${sum[r]}`).join(' · ')}`);
console.log(
  `module-shape: ${wrong.length} module(s) Wrong, ${wrong.filter(([, r]) => RULES.filter((k) => r.counts[k] > 0).length >= 2).length} due for rewrite (two or more rules); ${cycles.length} cycle(s), the largest ${cycles[0]?.length ?? 0} modules; ${Object.keys(multiWriter).length} table(s) written from more than one module`,
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
if (fell.length)
  console.log(
    `\nmodule-shape: ${fell.length} count(s) fell below the baseline — run --update-baseline to bank them`,
  );
if (rose.length) {
  console.log(
    `\nmodule-shape: ${rose.length} count(s) rose above the baseline ${config.baseline}:`,
  );
  for (const r of rose) console.log(`  ${r.key}: ${r.was} -> ${r.now}`);
}
if (config.mode === 'report') {
  console.log(
    `\nmodule-shape: report-only (${config.amnesty?.issue ?? 'no issue named'} ends it) — the findings above are Wrong markers, not a gate`,
  );
  process.exit(0);
}
process.exit(rose.length ? 1 : 0);
