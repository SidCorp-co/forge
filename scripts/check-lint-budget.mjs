#!/usr/bin/env node
// Per-file lint budget for packages biome cannot be gated on outright.
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
// A scope may additionally declare `drain`, and then freezing is not the whole
// contract: a changed file with debt must come back STRICTLY lower. Adding a
// scope is a `.forge/conformance.json` entry plus one --update-baseline run.
//
// Modes: --all (CI) · --staged (freeze-only; no hook runs it today) · --update-baseline
// Exit: 0 clean · 1 a file gained a violation or skipped its payment · 2 could not run.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  drainedLine,
  drainFaults,
  drainMatcher,
  emptiedScopes,
  mergeOriginal,
  SIZE_RULES,
} from './lib/lint-budget.mjs';
import { absentPrerequisites, remedyLines } from './lib/prerequisite.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  const measured = {};
  const scopeOf = new Map();
  const silent = [];

  const missing = absentPrerequisites(ROOT, ['deps']);
  if (missing.length > 0) return { error: `could not run — ${remedyLines(missing)[0]}` };

  for (const scope of scopes) {
    const cwd = join(ROOT, scope.cwd);
    if (!existsSync(cwd)) return { error: `scope directory missing: ${scope.cwd}` };

    const disabled = linterFault(scope);
    if (disabled) return { error: disabled };

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
    const summary = parsed.summary ?? {};
    const scanned = (summary.changed ?? 0) + (summary.unchanged ?? 0);
    if (!Number.isFinite(scanned) || scanned === 0) silent.push(scope.cwd);

    const broken = diags.find((d) => String(d.category ?? '').startsWith('internalError'));
    if (broken) {
      return { error: `biome could not read ${scope.cwd}: ${broken.category}` };
    }

    for (const d of diags) {
      const rule = d.category;
      const path = d.location?.path?.file ?? d.location?.path;
      if (!rule || typeof path !== 'string' || SIZE_RULES.has(rule)) continue;
      const rel = relative(ROOT, join(cwd, path));
      measured[rel] ??= {};
      measured[rel][rule] = (measured[rel][rule] ?? 0) + 1;
      scopeOf.set(rel, scope.cwd);
    }
  }

  if (silent.length > 0) {
    return {
      error: `biome scanned no files in ${silent.join(', ')} — scope matched nothing`,
    };
  }
  return { measured, scopeOf };
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function branchDelta() {
  const head = git(['rev-parse', 'HEAD']);
  const base = git(['merge-base', 'origin/main', 'HEAD']);
  if (!head) return { skip: 'no git HEAD' };
  if (!base) return { skip: 'no origin/main to compare against (shallow or detached checkout)' };
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

const { measured, scopeOf, error } = collect(cfg.scopes);
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

const failures = freezeFaults(measured, baseline.files, staged?.files ?? null);

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
  `lint-budget: ${Object.keys(measured).length} file(s) with lint debt, ${total(measured)} violation(s) frozen against the baseline`,
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
