#!/usr/bin/env node
// File- and function-length budget — the baseline biome does not have.
//
// biome already OWNS this rule: noExcessiveLinesPerFile (500) and
// noExcessiveLinesPerFunction (150) live in packages/core/biome.json. This adds
// no rule of its own. What biome lacks is a baseline, so the only two settings
// available were "warn" (143 violations, `biome check` exits 0, nothing gated)
// and "error" (143 violations, every build red). The repo's other three axes all
// solve that the same way: freeze today, block tomorrow.
//
// Frozen per FILE, not per line: a file records its length and the length of its
// longest function, and may only improve. Moving a function or reflowing a file
// therefore is not a violation — the same property that lets codemap's baseline
// survive a refactor.
//
// Modes: --all (CI) · --staged (freeze-only; no hook runs it today) · --update-baseline
// Exit: 0 clean · 1 a file got longer or a new one is over budget · 2 could not run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.forge', 'size-baseline.json');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

// cm:guard the two rules sit in DIFFERENT biome groups — file length under `style`, function length under `complexity`. Assuming both were `complexity` produced a baseline that silently froze 0 of the 56 file-length violations and still reported clean.
const FILE_RULE = 'lint/style/noExcessiveLinesPerFile';
const FN_RULE = 'lint/complexity/noExcessiveLinesPerFunction';

// cm:guard fails closed on an absent registry exactly like check-lint-budget.mjs, and the two must not drift. A built-in fallback here meant the same missing .forge/conformance.json made one checker exit 2 and its sibling quietly measure a hardcoded scope and report a result — the softer answer to the more complete failure, in the same CI job. It also matters to conformance-audit R9, which reads THIS checker's scope list out of the manifest to decide who owns the two length rules: a fallback the manifest never declared makes the audit and the checker disagree about what is covered.
function config() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    return { error: `${CONFIG_PATH} could not be read: ${err.code ?? err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${CONFIG_PATH} is not valid JSON: ${err.message}` };
  }
  const scopes = parsed?.checkers?.['size-budget']?.scopes;
  if (!Array.isArray(scopes)) {
    return { error: `${CONFIG_PATH} declares no checkers['size-budget'].scopes array` };
  }
  if (scopes.length === 0) {
    return {
      error: `${CONFIG_PATH} declares an empty size-budget scope list — nothing would be measured`,
    };
  }
  return { scopes };
}

// cm:edge contract -> packages/core/biome.json — reads the two rule categories declared there. Turning either rule off, or renaming it, empties this checker's input and it reports clean; the zero-diagnostics guard below is what turns that into an exit 2 instead of a false pass.
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
      if (d.category !== FILE_RULE && d.category !== FN_RULE) continue;
      const path = d.location?.path;
      const lines = Number(/\((\d+)\)/.exec(d.message ?? '')?.[1] ?? 0);
      if (!path || !lines) continue;
      const rel = relative(ROOT, join(cwd, path));
      const entry = measured.get(rel) ?? { fileLines: 0, maxFunctionLines: 0 };
      if (d.category === FILE_RULE) entry.fileLines = Math.max(entry.fileLines, lines);
      else entry.maxFunctionLines = Math.max(entry.maxFunctionLines, lines);
      measured.set(rel, entry);
    }
  }

  // cm:guard biome emitting nothing at all means the scope matched no files or the config stopped loading, NOT a clean tree — this repo has 464 diagnostics at rest. Reporting clean here is the fail-open shape the other checkers exit 2 on.
  if (!sawAnyDiagnostic)
    return { error: 'biome reported zero diagnostics — the scope matched nothing' };
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

const mode = process.argv[2] ?? '--all';
if (!['--all', '--staged', '--update-baseline'].includes(mode)) {
  console.error('usage: check-size-budget.mjs [--all|--staged|--update-baseline]');
  process.exit(2);
}

const cfg = config();
if (cfg.error) {
  console.error(`check-size-budget: ${cfg.error}`);
  process.exit(2);
}

const { measured, error } = collect(cfg.scopes);
if (error) {
  console.error(`check-size-budget: ${error}`);
  process.exit(2);
}

if (mode === '--update-baseline') {
  const files = Object.fromEntries([...measured.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2)}\n`,
  );
  console.log(`size-budget baseline written: ${measured.size} file(s) frozen`);
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  console.error(`check-size-budget: ${BASELINE_PATH} is unreadable — refusing to report clean`);
  process.exit(2);
}

// cm:guard a rule the baseline knows about must still be PRODUCING diagnostics. Freezing 56 file-length violations and then reading zero of them is indistinguishable from a clean tree by count alone, and that is exactly how a wrong rule category (style vs complexity) shipped a baseline that gated nothing. Re-baseline after a genuine cleanup and this self-corrects.
for (const kind of ['fileLines', 'maxFunctionLines']) {
  const expected = Object.values(baseline).some((v) => v[kind] > 0);
  const seen = [...measured.values()].some((v) => v[kind] > 0);
  if (expected && !seen) {
    console.error(
      `check-size-budget: the baseline records ${kind} violations but this run found none.\n` +
        'Either the rule stopped firing (check its category in packages/core/biome.json)\n' +
        'or they were genuinely cleaned up — in which case re-freeze with --update-baseline.',
    );
    process.exit(2);
  }
}

const scope = mode === '--staged' ? stagedFiles() : null;
const failures = [];
for (const [file, now] of measured) {
  if (scope && !scope.has(file)) continue;
  const was = baseline[file] ?? { fileLines: 0, maxFunctionLines: 0 };
  const reasons = [];
  if (now.fileLines > was.fileLines) {
    reasons.push(`file is ${now.fileLines} lines (baseline allowed ${was.fileLines || 'none'})`);
  }
  if (now.maxFunctionLines > was.maxFunctionLines) {
    reasons.push(
      `longest function is ${now.maxFunctionLines} lines (baseline allowed ${was.maxFunctionLines || 'none'})`,
    );
  }
  if (reasons.length) failures.push({ file, reasons });
}

console.log(`size-budget: ${measured.size} file(s) over budget, frozen against the baseline`);
if (failures.length === 0) process.exit(0);

for (const f of failures) {
  console.error(`\n${f.file}`);
  for (const r of f.reasons) console.error(`  ${r}`);
}
console.error(
  `\n${failures.length} file(s) exceeded their frozen size budget.\n` +
    'Split the function or the file — the budget is 150 lines per function, 500 per file.\n' +
    'A file already over budget may stay over, but it may not get worse.\n' +
    'If the growth is legitimate, re-freeze it:\n' +
    '  node scripts/check-size-budget.mjs --update-baseline\n',
);
process.exit(1);
