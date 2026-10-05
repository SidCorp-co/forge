#!/usr/bin/env node
// Pattern v2's module declaration and semantic rules (docs/conventions/domain-entities.md, ADR 0008)
// over packages/core/src. It refuses a declaration that contradicts itself
// (packages/core/src/modules.json: a table owned twice, `owns` on a kind that owns nothing, a module
// with no known context, a directory with no declared kind), then runs the type-aware ESLint rules
// in scripts/eslint-module-shape: a write to a table outside its owner module, a database call in a
// route file, a refusal built outside packages/core/src/lib/refusal.ts and the global fetch outside
// an adapter. A status written outside the kernel transition is refused by the database
// (`forge_kernel_status_guard`), not here. The import rules are scripts/check-module-boundaries.mjs's.
//
// It also judges the requirement trace (ISS-221, lib/module-trace.mjs): every core module, web-v2
// feature directory and runner crate names in `serves` the requirements and workflow steps it
// exists for, checked against the committed snapshot .forge/design-index.json
// (scripts/refresh-design-index.mjs writes it; verify makes no network call). Untraced units are
// frozen in the shrink-only .forge/module-trace-baseline.json; --update-trace-baseline rewrites it
// and refuses to let any rule's count rise.
//
// Today's lint violations are frozen in .forge/module-shape-suppressions.json (ESLint bulk
// suppressions). Exits 1 on a refused declaration, a violation the file does not hold, an entry that
// no longer occurs, or a rule whose frozen count rose over the base revision; 2 when it cannot run.
// --prune drops the entries that no longer occur; --markers writes every finding, frozen or not,
// as the reconciliation Wrong markers.
//
//   node scripts/check-module-shape.mjs [--prune] [--markers <file>] [--update-trace-baseline]

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { baseRevision } from './lib/baseline-ratchet.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';
import {
  kindFindings,
  markers,
  moduleOf,
  parseDeclaration,
  RULES,
  tally,
  totals,
} from './lib/module-shape.mjs';
import {
  judgeTrace,
  TRACE_RULE_SAYS,
  TRACE_RULES,
  TRACE_SCOPES,
  traceFindings,
} from './lib/module-trace.mjs';

const die = dieAs('module-shape');

const SRC = join(ROOT, 'packages/core/src');
const DECLARATION = 'packages/core/src/modules.json';
const SUPPRESSIONS = '.forge/module-shape-suppressions.json';
const CONFIG = 'scripts/eslint-module-shape/eslint.config.mjs';
const ESLINT = join(ROOT, 'node_modules/eslint/bin/eslint.js');
const PREFIX = 'module-shape/';
const LINT_RULES = RULES.filter((r) => r !== 'kind');
const DESIGN_INDEX = '.forge/design-index.json';
const TRACE_BASELINE = '.forge/module-trace-baseline.json';

const args = process.argv.slice(2);
const known = new Set(['--markers', '--prune', '--update-trace-baseline']);
for (const [i, a] of args.entries()) {
  if (a.startsWith('--') && !known.has(a))
    die(`unknown flag ${a} — one of ${[...known].join(', ')}`);
  if (!a.startsWith('--') && args[i - 1] !== '--markers') die(`unexpected argument ${a}`);
}
const markersAt = args.indexOf('--markers');
const markersPath = markersAt === -1 ? null : args[markersAt + 1];
if (markersAt !== -1 && (!markersPath || markersPath.startsWith('--')))
  die('--markers needs a path');
const prune = args.includes('--prune');
const updateTrace = args.includes('--update-trace-baseline');

let declaration;
try {
  declaration = JSON.parse(readFileSync(join(ROOT, DECLARATION), 'utf8'));
} catch (err) {
  die(`${DECLARATION} is unreadable: ${err.message}`);
}
const { faults, modules } = parseDeclaration(declaration);
const dirs = readdirSync(SRC).filter((d) => statSync(join(SRC, d)).isDirectory());
const kinds = kindFindings(dirs, modules);
faults.push(...kinds.map((f) => `modules.json: ${f.detail}`));
for (const path of Object.keys(modules)) {
  if (path !== '(root)' && !existsSync(join(SRC, path)))
    faults.push(`modules.json: declares ${path}, which has no directory under packages/core/src`);
}
const config = (await import(join(ROOT, CONFIG))).default;
for (const block of config) {
  for (const entry of block.rules?.['module-shape/global-fetch']?.[1]?.allow ?? []) {
    if (!existsSync(join(ROOT, entry.file)))
      faults.push(`${CONFIG}: global-fetch allows ${entry.file}, which no longer exists`);
  }
  for (const entry of block.rules?.['module-shape/table-writer']?.[1]?.generic ?? []) {
    if (!existsSync(join(ROOT, entry.file)))
      faults.push(`${CONFIG}: table-writer names ${entry.file} generic, which no longer exists`);
  }
}
const readJson = (path, text) => {
  try {
    return JSON.parse(text ?? readFileSync(join(ROOT, path), 'utf8'));
  } catch (err) {
    die(`${path} is unreadable: ${err.message}`);
  }
};
const listDirs = (dir) =>
  readdirSync(join(ROOT, dir)).filter((d) => statSync(join(ROOT, dir, d)).isDirectory());
const designIndex = readJson(DESIGN_INDEX);
const trace = traceFindings(declaration, designIndex, {
  web: listDirs(TRACE_SCOPES.web.dir),
  runner: listDirs(`${TRACE_SCOPES.runner.dir}/crates`).map((c) => `crates/${c}`),
});
faults.push(...trace.faults);
if (faults.length) {
  console.error(`module-shape: refused:\n  ${faults.join('\n  ')}`);
  process.exit(1);
}

const { rev, refusal } = baseRevision(ROOT);
if (refusal) die(`no base revision can be taken: ${refusal}`);
if (!rev) die('no base revision to compare the baselines against; fetch history and re-run');
const atBase = (path) => {
  try {
    const text = execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return readJson(`${path} at ${rev.slice(0, 9)}`, text);
  } catch {
    return null;
  }
};
const traceCounts = (rules) =>
  TRACE_RULES.map((r) => `${r} ${rules?.[r]?.length ?? 0}`).join(' · ');
const traceFrozen = existsSync(join(ROOT, TRACE_BASELINE)) ? readJson(TRACE_BASELINE).rules : null;
if (updateTrace) {
  const rose = traceFrozen
    ? TRACE_RULES.filter((r) => trace.findings[r].length > (traceFrozen[r]?.length ?? 0))
    : [];
  if (rose.length) {
    console.error(
      `module-shape: refused — ${rose.map((r) => `${r} ${traceFrozen[r]?.length ?? 0} -> ${trace.findings[r].length}`).join(', ')}; the trace baseline only shrinks, so declare what the new units serve instead`,
    );
    process.exit(1);
  }
  const doc = {
    $comment:
      'Units packages/core/src/modules.json does not yet trace to a requirement or workflow step, under the rule they break (scripts/lib/module-trace.mjs). Shrink-only: a new entry fails, an entry that no longer occurs fails, and a rule whose count rose over the base revision fails. Rewrite with node scripts/check-module-shape.mjs --update-trace-baseline after tracing or deleting a unit, never to admit one.',
    rules: trace.findings,
  };
  writeFileSync(join(ROOT, TRACE_BASELINE), `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`module-shape: wrote ${TRACE_BASELINE} (${traceCounts(trace.findings)})`);
  process.exit(0);
}
if (!traceFrozen) die(`${TRACE_BASELINE} is absent; --update-trace-baseline writes it`);
const traceJudged = judgeTrace(trace.findings, traceFrozen, atBase(TRACE_BASELINE)?.rules);

if (!existsSync(ESLINT)) die(`${relative(ROOT, ESLINT)} is absent; run pnpm install`);
if (!existsSync(join(ROOT, SUPPRESSIONS))) die(`${SUPPRESSIONS} is absent`);
const lint = spawnSync(
  process.execPath,
  [
    ESLINT,
    '-c',
    CONFIG,
    '--format',
    'json',
    '--suppressions-location',
    SUPPRESSIONS,
    ...(prune ? ['--prune-suppressions'] : []),
    'packages/core/src',
  ],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 29 },
);
let results;
try {
  results = JSON.parse(lint.stdout);
} catch {
  die(`eslint could not run (exit ${lint.status}):\n${lint.stderr || lint.stdout}`);
}

const rel = (abs) => relative(ROOT, abs).split(sep).join('/');
const linted = new Set();
const found = [];
const fresh = [];
for (const r of results) {
  const file = rel(r.filePath);
  linted.add(file);
  for (const m of r.messages) {
    if (!m.ruleId) die(`eslint could not read ${file}:${m.line}: ${m.message}`);
    if (!m.ruleId.startsWith(PREFIX)) continue;
    fresh.push({ file, ...m });
    found.push({ file, ...m });
  }
  for (const m of r.suppressedMessages ?? [])
    if (m.ruleId?.startsWith(PREFIX)) found.push({ file, ...m });
}

const readSuppressions = (text, where) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${where} is not JSON: ${err.message}`);
  }
};
const frozen = readSuppressions(readFileSync(join(ROOT, SUPPRESSIONS), 'utf8'), SUPPRESSIONS);
const occurs = new Map();
for (const f of found)
  occurs.set(`${f.file}\0${f.ruleId}`, (occurs.get(`${f.file}\0${f.ruleId}`) ?? 0) + 1);
const stale = [];
for (const [file, rules] of Object.entries(frozen)) {
  for (const [rule, { count }] of Object.entries(rules)) {
    const now = linted.has(file) ? (occurs.get(`${file}\0${rule}`) ?? 0) : 0;
    if (now < count) stale.push(`${file}  ${rule}: ${count} frozen, ${now} occur`);
  }
}

const perRule = (doc) => {
  const out = Object.fromEntries(LINT_RULES.map((r) => [r, 0]));
  for (const rules of Object.values(doc ?? {}))
    for (const [rule, { count }] of Object.entries(rules))
      out[rule.slice(PREFIX.length)] = (out[rule.slice(PREFIX.length)] ?? 0) + count;
  return out;
};
const before = atBase(SUPPRESSIONS);
const nowFrozen = perRule(frozen);
const wasFrozen = before ? perRule(before) : null;
const grown = wasFrozen
  ? LINT_RULES.filter((r) => nowFrozen[r] > wasFrozen[r]).map(
      (r) => `${r}: ${wasFrozen[r]} -> ${nowFrozen[r]}`,
    )
  : [];

const findings = [
  ...kinds,
  ...found.map((f) => ({
    rule: f.ruleId.slice(PREFIX.length),
    module: moduleOf(f.file, modules),
    file: f.file,
    line: f.line,
    detail: f.message,
  })),
];
const byModule = tally(findings, modules, dirs);
if (markersPath) {
  const sha =
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() || null;
  writeFileSync(markersPath, `${JSON.stringify(markers(byModule, { atSha: sha }), null, 1)}\n`);
  console.log(`module-shape: wrote ${markersPath}`);
}

const sum = totals(byModule);
console.log(
  `module-shape: ${linted.size} file(s) linted across ${Object.keys(modules).length} module(s)`,
);
console.log(`module-shape: found  ${LINT_RULES.map((r) => `${r} ${sum[r]}`).join(' · ')}`);
console.log(`module-shape: frozen ${LINT_RULES.map((r) => `${r} ${nowFrozen[r]}`).join(' · ')}`);
const traced = Object.values(TRACE_SCOPES).map(({ section }) => {
  const units = Object.values(declaration[section]);
  return `${section} ${units.filter((u) => u.serves?.length).length}/${units.length}`;
});
console.log(`module-shape: traced ${traced.join(' · ')}`);
console.log(`module-shape: untraced now    ${traceCounts(trace.findings)}`);
console.log(`module-shape: untraced frozen ${traceCounts(traceFrozen)}`);

const show = (title, list) => {
  if (!list.length) return;
  console.error(`\nmodule-shape: ${list.length} ${title}`);
  for (const line of list) console.error(`  ${line}`);
};
show(
  `violation(s) ${SUPPRESSIONS} does not hold — fix them, never freeze them`,
  fresh.map((f) => `${f.file}:${f.line}  ${f.ruleId.slice(PREFIX.length)}  ${f.message}`),
);
show(`stale entr(y/ies), no longer violated — run with --prune to drop them`, stale);
show(`rule(s) whose frozen count rose over ${rev.slice(0, 9)}`, grown);
show(
  `untraced unit(s) ${TRACE_BASELINE} does not hold — declare what each serves, or delete it`,
  traceJudged.fresh.map((f) => `${f}  (${TRACE_RULE_SAYS[f.split(':')[0]]})`),
);
show(
  `stale trace baseline entr(y/ies) — run --update-trace-baseline to drop them`,
  traceJudged.stale,
);
show(`trace rule(s) whose frozen count rose over ${rev.slice(0, 9)}`, traceJudged.grown);
const traceRed = traceJudged.fresh.length || traceJudged.stale.length || traceJudged.grown.length;
if (fresh.length || stale.length || grown.length || traceRed) process.exit(1);
console.log(
  'module-shape: every violation and untraced unit is frozen and every frozen entry still occurs',
);
