#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { baseRef } from './lib/base-branch.mjs';
import {
  freezeFaults,
  loadBaseline,
  parseMode,
  scopeConfig,
  sortDeep,
  stagedFiles,
  total,
  writeBaseline,
} from './lib/debt-ratchet.mjs';
import { gitOut, ROOT } from './lib/gate.mjs';
import {
  biomeReport,
  drainedLine,
  drainFaults,
  drainMatcher,
  emptiedScopes,
  explainFaults,
  mergeOriginal,
  readDiagnostic,
} from './lib/lint-budget.mjs';
import { absentPrerequisites, remedyLines } from './lib/prerequisite.mjs';

const BASELINE_PATH = join(ROOT, '.forge', 'lint-baseline.json');

function effectiveLinterEnabled(file, stack = []) {
  if (stack.includes(file)) return { error: `${relative(ROOT, file)} is part of an extends cycle` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `${relative(ROOT, file)} could not be read: ${err.code ?? err.message}` };
  }
  let enabled;
  const extend = doc?.extends;
  if (extend !== undefined) {
    if (!Array.isArray(extend)) {
      return {
        error: `${relative(ROOT, file)} declares a non-array extends this checker cannot resolve`,
      };
    }
    for (const entry of extend) {
      if (typeof entry !== 'string' || !entry.startsWith('.')) {
        return {
          error: `${relative(ROOT, file)} extends ${JSON.stringify(entry)}, which this checker cannot resolve — declare a relative path or stop disabling the linter behind one`,
        };
      }
      const parent = effectiveLinterEnabled(join(dirname(file), entry), [...stack, file]);
      if (parent.error) return parent;
      if (parent.enabled !== undefined) enabled = parent.enabled;
    }
  }
  if (doc?.linter?.enabled !== undefined) enabled = doc.linter.enabled;
  return { enabled };
}

function linterFault(scope) {
  const { enabled, error } = effectiveLinterEnabled(join(ROOT, scope.cwd, 'biome.json'));
  if (error) return error;
  if (enabled === false) {
    return `${scope.cwd} resolves to a biome config with its linter disabled — this scope would report clean while measuring nothing`;
  }
  return null;
}

function collect(scopes) {
  let scannedTotal = 0;
  const measured = {};
  const said = {};
  const scopeOf = new Map();
  const silent = [];

  const missing = absentPrerequisites(ROOT, ['deps']);
  if (missing.length > 0) return { error: `could not run — ${remedyLines(missing)[0]}` };

  for (const scope of scopes) {
    const { cwd, report: parsed, error } = biomeReport(ROOT, scope);
    if (error) return { error };

    const disabled = linterFault(scope);
    if (disabled) return { error: disabled };

    const diags = parsed.diagnostics ?? [];
    const summary = parsed.summary ?? {};
    const scanned = (summary.changed ?? 0) + (summary.unchanged ?? 0);
    if (!Number.isFinite(scanned) || scanned === 0) silent.push(scope.cwd);
    else scannedTotal += scanned;

    const broken = diags.find((d) => String(d.category ?? '').startsWith('internalError'));
    if (broken) {
      return { error: `biome could not read ${scope.cwd}: ${broken.category}` };
    }

    for (const d of diags) {
      const diag = readDiagnostic(d);
      if (diag === null) continue;
      const { rule, line, message } = diag;
      const rel = relative(ROOT, join(cwd, diag.path));
      measured[rel] ??= {};
      measured[rel][rule] = (measured[rel][rule] ?? 0) + 1;
      said[rel] ??= {};
      said[rel][rule] ??= [];
      said[rel][rule].push({ line, message });
      scopeOf.set(rel, scope.cwd);
    }
  }

  if (silent.length > 0) {
    return {
      error: `biome scanned no files in ${silent.join(', ')} — scope matched nothing`,
    };
  }
  return { measured, said, scopeOf, scanned: scannedTotal };
}

const git = (args) => gitOut(args)?.trim() ?? null;

function branchDelta() {
  const head = git(['rev-parse', 'HEAD']);
  if (!head) return { skip: 'no git HEAD' };
  const target = baseRef(ROOT);
  if (target.refusal) return { skip: target.summary };
  const base = git(['merge-base', target.ref, 'HEAD']);
  if (!base) return { skip: `no merge-base with ${target.ref} (shallow or detached checkout)` };
  if (base === head) return { skip: `merge-base is HEAD (${base.slice(0, 8)}) — no branch delta` };

  const names = git(['diff', '--name-only', base]);
  const renames = git(['diff', '--diff-filter=R', '-M', '--name-status', base]);
  if (names === null || renames === null) return { error: `git diff against ${base} failed` };

  const changed = new Set(names.split('\n').filter(Boolean));
  const renamed = new Map();
  for (const line of renames.split('\n').filter(Boolean)) {
    const [, from, to] = line.split('\t');
    if (from && to) renamed.set(to, from);
  }
  return { base, changed, renamed };
}

function totalsByScope(files, scopeOf, scopes) {
  const out = new Map(scopes.map((s) => [s.cwd, 0]));
  for (const [file, rules] of Object.entries(files)) {
    const scope = scopeOf.get(file) ?? scopes.find((s) => file.startsWith(`${s.cwd}/`))?.cwd;
    if (scope === undefined) continue;
    out.set(scope, (out.get(scope) ?? 0) + total({ [file]: rules }));
  }
  return out;
}

const parsed = parseMode(
  process.argv,
  ['--all', '--staged', '--update-baseline'],
  'check-lint-budget.mjs',
);
if (parsed.error) {
  console.error(parsed.error);
  process.exit(2);
}
const mode = parsed.mode;

const cfg = scopeConfig(ROOT, 'lint-budget');
if (cfg.error) {
  console.error(`check-lint-budget: ${cfg.error}`);
  process.exit(2);
}

const { measured, said, scopeOf, scanned, error } = collect(cfg.scopes);
if (error) {
  console.error(`check-lint-budget: ${error}`);
  process.exit(2);
}

const currentByScope = totalsByScope(measured, scopeOf, cfg.scopes);

if (mode === '--update-baseline') {
  const previousDoc = loadBaseline(BASELINE_PATH);
  if (previousDoc === null) {
    console.error(`check-lint-budget: ${BASELINE_PATH} is unreadable — refusing to overwrite it`);
    process.exit(2);
  }
  const previous = { files: previousDoc.files ?? {}, original: previousDoc.original ?? {} };
  const emptied = emptiedScopes(
    currentByScope,
    totalsByScope(previous.files, new Map(), cfg.scopes),
  );
  const accepted = new Set(
    process.argv
      .filter((a) => a.startsWith('--accept-emptied-scope='))
      .map((a) => a.slice('--accept-emptied-scope='.length)),
  );
  const unconfirmed = emptied.filter((s) => !accepted.has(s));
  if (unconfirmed.length > 0) {
    console.error(
      `check-lint-budget: ${unconfirmed.join(', ')} measured ZERO diagnostics but the baseline freezes debt for it.\n` +
        'Either that scope genuinely drained to zero, or it is no longer being linted — an\n' +
        '`overrides` block, a narrowed `files.includes` or an ignore file all look identical from here.\n' +
        'Confirm it is the first, then name it to record it:\n' +
        unconfirmed.map((s) => `  --accept-emptied-scope=${s}`).join('\n') +
        '\n',
    );
    process.exit(2);
  }
  const files = sortDeep(measured);
  const original = mergeOriginal(previous.original, currentByScope);
  writeBaseline(BASELINE_PATH, { generatedAt: new Date().toISOString(), original, files });
  console.log(
    `lint-budget baseline written: ${Object.keys(files).length} file(s), ${total(files)} violation(s) frozen`,
  );
  for (const [scope, n] of currentByScope) console.log(drainedLine(scope, n, original[scope]));
  process.exit(0);
}

const baselineDoc = loadBaseline(BASELINE_PATH);
if (baselineDoc === null) {
  console.error(`check-lint-budget: ${BASELINE_PATH} is unreadable — refusing to report clean`);
  process.exit(2);
}
const baseline = { files: baselineDoc.files ?? {}, original: baselineDoc.original ?? {} };

const emptied = emptiedScopes(currentByScope, totalsByScope(baseline.files, new Map(), cfg.scopes));
if (emptied.length > 0) {
  console.error(
    `check-lint-budget: ${emptied.join(', ')} measured ZERO diagnostics but the baseline freezes debt for it.\n` +
      'A scope that stopped being linted and a scope that drained to zero look identical by count,\n' +
      'so this refuses rather than reporting clean. If it genuinely drained, record it with:\n' +
      '  node scripts/check-lint-budget.mjs --update-baseline --accept-emptied-scope=<scope>\n',
  );
  process.exit(2);
}

let staged = null;
if (mode === '--staged') {
  staged = stagedFiles(ROOT);
  if (staged.error) {
    console.error(`check-lint-budget: ${staged.error}`);
    process.exit(2);
  }
}

const failures = explainFaults(freezeFaults(measured, baseline.files, staged?.files ?? null), said);

let matchers;
try {
  matchers = cfg.scopes.map(drainMatcher).filter(Boolean);
} catch (err) {
  console.error(`check-lint-budget: ${err.message}`);
  process.exit(2);
}
let drainNote = null;
let drainFailed = false;
if (mode === '--all' && matchers.length > 0) {
  const delta = branchDelta();
  if (delta.error) {
    console.error(`check-lint-budget: ${delta.error}`);
    process.exit(2);
  }
  if (delta.skip) {
    drainNote = `drain skipped — ${delta.skip}; freeze-only this run`;
  } else {
    drainNote = `drain judged over ${delta.changed.size} changed file(s) since ${delta.base.slice(0, 8)}`;
    const unpaid = drainFaults({
      measured,
      baseline: baseline.files,
      changed: delta.changed,
      renamed: delta.renamed,
      matchers,
    });
    drainFailed = unpaid.length > 0;
    failures.push(...unpaid);
  }
}

console.log(
  `lint-budget: ${scanned} file(s) scanned, ${Object.keys(measured).length} with lint debt, ${total(measured)} violation(s) frozen against the baseline`,
);
for (const [scope, n] of currentByScope)
  console.log(drainedLine(scope, n, baseline.original[scope]));
if (drainNote) console.log(`  ${drainNote}`);
if (failures.length === 0) process.exit(0);

const byFile = new Map();
for (const f of failures) {
  const reasons = byFile.get(f.file) ?? [];
  reasons.push(...f.reasons);
  byFile.set(f.file, reasons);
}
for (const [file, reasons] of byFile) {
  console.error(`\n${file}`);
  for (const r of reasons) console.error(`  ${r}`);
}
console.error(
  `\n${byFile.size} file(s) failed the lint budget.\n` +
    'A file already carrying debt may keep it, but it may not gain more — and a file you\n' +
    'touched in a draining scope must come back strictly lower than its baseline.\n' +
    'See the diagnostics in full with: pnpm --filter <pkg> exec biome check src\n' +
    'Pay a drain by removing one: restructure so the compiler narrows it, or keep the\n' +
    'assertion behind a `// biome-ignore <rule>: <the invariant>` that states why it holds.\n' +
    'Never `biome check --write` these rules — it rewrites `a!.b` to `a?.b`, turning "throw\n' +
    'when the invariant is violated" into "silently undefined".\n' +
    (drainFailed
      ? 'A drain has no re-freeze escape: --update-baseline re-measures the file and writes the\n' +
        'same count back, so the next run fails the same way. Remove one diagnostic.\n'
      : 'If the growth is deliberate, re-freeze it:\n' +
        '  node scripts/check-lint-budget.mjs --update-baseline\n'),
);
process.exit(1);
