#!/usr/bin/env node
import { join, relative } from 'node:path';
import {
  loadBaseline,
  parseMode,
  scopeConfig,
  sortDeep,
  stagedFiles,
  writeBaseline,
} from './lib/debt-ratchet.mjs';
import { ROOT } from './lib/gate.mjs';
import { absentPrerequisites, remedyLines } from './lib/prerequisite.mjs';
import { biomeReport, branchDelta, drainFaults, drainMatcher } from './lib/size-budget.mjs';

const BASELINE_PATH = join(ROOT, '.forge', 'size-baseline.json');

const FILE_RULE = 'lint/style/noExcessiveLinesPerFile';
const FN_RULE = 'lint/complexity/noExcessiveLinesPerFunction';

function collect(scopes) {
  const measured = new Map();
  let scanned = 0;

  const missing = absentPrerequisites(ROOT, ['deps']);
  if (missing.length > 0) return { error: `could not run — ${remedyLines(missing)[0]}` };

  for (const scope of scopes) {
    const { cwd, report: parsed, error } = biomeReport(ROOT, scope);
    if (error) return { error };

    const diags = parsed.diagnostics ?? [];
    scanned += (parsed.summary?.changed ?? 0) + (parsed.summary?.unchanged ?? 0);

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

  // Zero diagnostics over scanned files is a clean scope; zero files scanned is a scope that
  // matched nothing, and only that is refused.
  if (scanned === 0) return { error: 'biome scanned zero files — the scope matched nothing' };
  return { measured, scanned };
}

const parsed = parseMode(
  process.argv,
  ['--all', '--staged', '--update-baseline'],
  'check-size-budget.mjs',
);
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}
const mode = parsed.mode;

const cfg = scopeConfig(ROOT, 'size-budget');
if (cfg.error) {
  console.error(`check-size-budget: ${cfg.error}`);
  process.exit(2);
}

const { measured, scanned, error } = collect(cfg.scopes);
if (error) {
  console.error(`check-size-budget: ${error}`);
  process.exit(2);
}

if (mode === '--update-baseline') {
  writeBaseline(BASELINE_PATH, {
    generatedAt: new Date().toISOString(),
    files: sortDeep(Object.fromEntries(measured)),
  });
  console.log(`size-budget baseline written: ${measured.size} file(s) frozen`);
  process.exit(0);
}

const doc = loadBaseline(BASELINE_PATH);
if (doc === null) {
  console.error(`check-size-budget: ${BASELINE_PATH} is unreadable — refusing to report clean`);
  process.exit(2);
}
const baseline = doc.files ?? {};

for (const kind of ['fileLines', 'maxFunctionLines']) {
  const expected = Object.values(baseline).some((v) => v[kind] > 0);
  const seen = [...measured.values()].some((v) => v[kind] > 0);
  if (expected && !seen) {
    console.error(
      `check-size-budget: the baseline records ${kind} violations but this run found none.\n` +
        "Either the rule stopped firing (check its category in the scope's biome.json)\n" +
        'or they were genuinely cleaned up — in which case re-freeze with --update-baseline.',
    );
    process.exit(2);
  }
}

let scope = null;
if (mode === '--staged') {
  const staged = stagedFiles(ROOT);
  if (staged.error) {
    console.error(`check-size-budget: ${staged.error}`);
    process.exit(2);
  }
  scope = staged.files;
}
const failures = [];
let matchers;
try {
  matchers = cfg.scopes.map(drainMatcher).filter(Boolean);
} catch (err) {
  console.error(`check-size-budget: ${err.message}`);
  process.exit(2);
}
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

let drainNote = null;
let drainFailed = false;
if (mode === '--all' && matchers.length > 0) {
  const delta = branchDelta(ROOT);
  if (delta.error) {
    console.error(`check-size-budget: ${delta.error}`);
    process.exit(2);
  }
  if (delta.skip) {
    drainNote = `drain skipped — ${delta.skip}; freeze-only this run`;
  } else {
    drainNote = `drain judged over ${delta.changed.size} changed file(s) since ${delta.base.slice(0, 8)}`;
    const unpaid = drainFaults({
      measured: Object.fromEntries(measured),
      baseline,
      changed: delta.changed,
      renamed: delta.renamed,
      matchers,
    });
    drainFailed = unpaid.length > 0;
    for (const u of unpaid) {
      const same = failures.find((f) => f.file === u.file);
      if (same) same.reasons.push(...u.reasons);
      else failures.push(u);
    }
  }
}

console.log(
  `size-budget: ${scanned} file(s) scanned, ${measured.size} over budget, frozen against the baseline`,
);
if (drainNote) console.log(`  ${drainNote}`);
if (failures.length === 0) process.exit(0);

for (const f of failures) {
  console.error(`\n${f.file}`);
  for (const r of f.reasons) console.error(`  ${r}`);
}
console.error(
  `\n${failures.length} file(s) exceeded their frozen size budget.\n` +
    'Split the function or the file — the budget is 150 lines per function, 500 per file.\n' +
    'A file already over budget may stay over, but it may not get worse, and a frozen file you\n' +
    'touched in a draining scope must come back strictly shorter.\n' +
    (drainFailed
      ? 'A drain has no re-freeze escape: --update-baseline writes the same count back.\n'
      : 'If the growth is legitimate, re-freeze it:\n' +
        '  node scripts/check-size-budget.mjs --update-baseline\n'),
);
process.exit(1);
