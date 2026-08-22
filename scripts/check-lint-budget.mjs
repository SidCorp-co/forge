#!/usr/bin/env node
// Per-file lint budget for a package biome cannot be gated on outright.
//
// biome OWNS the rules; this adds none. What it adds is the baseline biome has
// no concept of, so a package carrying real debt has only two settings —
// `error` (every build red) or `warn` (nothing holds). Same shape, and same
// reasoning, as check-size-budget.mjs: freeze today per FILE per RULE, block
// tomorrow. A file may keep its violations, may lose them, may never gain one.
//
// Frozen per (file, rule) rather than per line, so moving code inside a file
// or reflowing it is not a violation.
//
// Modes: --all (CI) · --staged (pre-commit) · --update-baseline
// Exit: 0 clean · 1 a file gained a violation · 2 could not run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.forge', 'lint-baseline.json');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

// cm:guard these two categories belong to check-size-budget.mjs, which freezes them by LINE COUNT. Counting them here as well would freeze the same debt under two directions of improvement, and a file that split one 300-line function into two would satisfy one checker while failing the other.
const SIZE_RULES = new Set([
  'lint/style/noExcessiveLinesPerFile',
  'lint/complexity/noExcessiveLinesPerFunction',
]);

const DEFAULT_SCOPES = [{ cwd: 'packages/web-v2', args: ['check', 'src'] }];

function config() {
  if (!existsSync(CONFIG_PATH)) return { scopes: DEFAULT_SCOPES };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { scopes: raw?.checkers?.['lint-budget']?.scopes ?? DEFAULT_SCOPES };
  } catch {
    return null;
  }
}

// cm:edge contract -> packages/web-v2/biome.json — reads whatever that config decides to report. Turning the linter off there empties this checker's input; the zero-diagnostics guard below is what makes that an exit 2 instead of a green run.
function collect(scopes) {
  const measured = new Map();
  let sawAnyDiagnostic = false;

  for (const scope of scopes) {
    const cwd = join(ROOT, scope.cwd);
    if (!existsSync(cwd)) return { error: `scope directory missing: ${scope.cwd}` };

    let stdout;
    try {
      stdout = execFileSync(
        'npx',
        ['biome', ...scope.args, '--reporter=json', '--max-diagnostics=5000'],
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    } catch (err) {
      stdout = err.stdout;
      if (!stdout) return { error: `biome produced no output in ${scope.cwd}: ${err.message}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { error: `biome output in ${scope.cwd} was not JSON` };
    }
    const diags = parsed.diagnostics ?? [];
    if (diags.length > 0) sawAnyDiagnostic = true;

    for (const d of diags) {
      const rule = d.category;
      const path = d.location?.path?.file ?? d.location?.path;
      if (!rule || typeof path !== 'string' || SIZE_RULES.has(rule)) continue;
      const rel = relative(ROOT, join(cwd, path));
      const entry = measured.get(rel) ?? {};
      entry[rule] = (entry[rule] ?? 0) + 1;
      measured.set(rel, entry);
    }
  }

  // cm:guard biome emitting nothing at all means the scope matched no files or the config stopped loading, NOT a clean tree — web-v2 carries 151 error-level diagnostics at rest. Reporting clean here is the fail-open shape every other checker exits 2 on.
  if (!sawAnyDiagnostic) return { error: 'biome reported zero diagnostics — the scope matched nothing' };
  return { measured };
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return new Set(out.split('\n').filter(Boolean));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
  } catch {
    return null;
  }
}

function totals(files) {
  let n = 0;
  for (const rules of Object.values(files)) for (const c of Object.values(rules)) n += c;
  return n;
}

const mode = process.argv[2] ?? '--all';
if (!['--all', '--staged', '--update-baseline'].includes(mode)) {
  console.error('usage: check-lint-budget.mjs [--all|--staged|--update-baseline]');
  process.exit(2);
}

const cfg = config();
if (!cfg) {
  console.error(`check-lint-budget: ${CONFIG_PATH} is unreadable`);
  process.exit(2);
}

const { measured, error } = collect(cfg.scopes);
if (error) {
  console.error(`check-lint-budget: ${error}`);
  process.exit(2);
}

if (mode === '--update-baseline') {
  const files = Object.fromEntries(
    [...measured.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, rules]) => [
        file,
        Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2)}\n`,
  );
  console.log(
    `lint-budget baseline written: ${measured.size} file(s), ${totals(files)} violation(s) frozen`,
  );
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  console.error(`check-lint-budget: ${BASELINE_PATH} is unreadable — refusing to report clean`);
  process.exit(2);
}

const scope = mode === '--staged' ? stagedFiles() : null;
const failures = [];
for (const [file, now] of measured) {
  if (scope && !scope.has(file)) continue;
  const was = baseline[file] ?? {};
  const reasons = [];
  for (const [rule, count] of Object.entries(now)) {
    const allowed = was[rule] ?? 0;
    if (count > allowed) reasons.push(`${rule}: ${count} (baseline allowed ${allowed})`);
  }
  if (reasons.length) failures.push({ file, reasons });
}

console.log(
  `lint-budget: ${measured.size} file(s) with lint debt, ${totals(Object.fromEntries(measured))} violation(s) frozen against the baseline`,
);
if (failures.length === 0) process.exit(0);

for (const f of failures) {
  console.error(`\n${f.file}`);
  for (const r of f.reasons) console.error(`  ${r}`);
}
console.error(
  `\n${failures.length} file(s) gained lint violations.\n` +
    'Fix them — a file already carrying debt may keep it, but it may not gain more.\n' +
    'See the diagnostic in full with: pnpm --filter web-v2 exec biome check src\n' +
    'If the growth is deliberate, re-freeze it:\n' +
    '  node scripts/check-lint-budget.mjs --update-baseline\n',
);
process.exit(1);
