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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  drainedLine,
  drainFaults,
  drainMatcher,
  emptiedScopes,
  freezeFaults,
  mergeOriginal,
  SIZE_RULES,
  total,
} from './lib/lint-budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, '.forge', 'lint-baseline.json');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

// cm:guard an ABSENT registry is not a default, it is a broken checkout. Falling back to a built-in scope list made a missing .forge/conformance.json quietly demote this to web-v2-only — core uncounted, drain gone, exit 0 — while an unreadable one exited 2, so the more complete failure got the softer answer. The file is committed; every spelling of "cannot read it" now fails closed, and each says WHICH — one message for four conditions sent a reader to check permissions on a file that parses fine.
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
  const scopes = parsed?.checkers?.['lint-budget']?.scopes;
  if (!Array.isArray(scopes)) {
    return { error: `${CONFIG_PATH} declares no checkers['lint-budget'].scopes array` };
  }
  if (scopes.length === 0) {
    return {
      error: `${CONFIG_PATH} declares an empty lint-budget scope list — nothing would be measured`,
    };
  }
  return { scopes };
}

// cm:guard ORTHOGONAL to the files-scanned guard, and both must stay. A disabled linter scans every file and reports nothing, so it passes a scanned-count check while emptying this checker's input — measured 2026-08-27: flipping `linter.enabled` to false in packages/web-v2/biome.json made --all exit 0 at "0 / 226 original (100% drained)" and made --update-baseline DELETE 95 files and 210 frozen diagnostics at exit 0, which compareDown accepts because it only faults on a rise. Counting diagnostics cannot tell that from a scope legitimately drained to zero; only the config can, which is why this reads the config instead.
// cm:guard follow `extends`, and REFUSE what cannot be followed. Reading only the scope's own biome.json left the identical hole one file away: a base config carrying `linter.enabled: false` and an `extends` pointing at it reproduced the whole failure — --all exit 0 at "100% drained", --update-baseline deleting all 95 web-v2 entries. A partial read of a config chain is not a weaker check, it is the same absent one wearing the previous fix's name.
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
  // cm:guard a STRING `extends` is biome's package form (e.g. "//some-pkg"), which this cannot resolve from the filesystem — so it is an error, never a skip. Treating an unresolvable parent as "nothing to see" is how a config chain hides the one line that matters.
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

// cm:edge contract -> packages/web-v2/biome.json — reads whatever that config decides to report. Turning the linter off there empties this checker's input; `linterFault` makes that an exit 2 by resolving the `extends` chain, so a base config one file away is caught too and an `extends` it cannot resolve is itself the error. The files-scanned guard below covers the different case of a scope that matched no files at all.
// cm:edge contract -> packages/core/biome.json — same for the second scope: `noNonNullAssertion` / `noExplicitAny` / the test override's `noUnsafeOptionalChaining` are `warn` there, which is exactly why they need a baseline — biome exits 0 on a warning, so the blocking `core` lint step passed over 280 of them (measured 2026-08-27)
function collect(scopes) {
  const measured = {};
  const scopeOf = new Map();
  const silent = [];

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
    // cm:guard count FILES SCANNED, never diagnostics found. Keying the empty-scope guard off an empty report made "this scope drained to zero" — the outcome the drain rule exists to produce — indistinguishable from "this scope stopped matching", so the success condition of the whole initiative was a build that exits 2. biome's own summary separates them; a scope that scanned files and found nothing is clean.
    const summary = parsed.summary ?? {};
    const scanned = (summary.changed ?? 0) + (summary.unchanged ?? 0);
    if (!Number.isFinite(scanned) || scanned === 0) silent.push(scope.cwd);

    // cm:guard `internalError/*` is biome saying it could not READ the scope, not a violation in it. Counted as debt it lands under a nonsense file key and exits 1, so the run blames the code for a registry that points at nothing — and it prints a drained percentage first, which for a scope biome never opened reads as 100%.
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

  // cm:guard PER SCOPE, never "any scope was scanned". With two scopes a global flag lets a healthy sibling vouch for a broken one, which reads as that whole package having drained to zero and lets every drain payment pass unpaid.
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

// cm:guard a failed `git diff --cached` must NOT become an empty staged set. freezeFaults skips every file outside the set, so null-to-empty makes --staged print a clean report and exit 0 over nothing — the same null-reads-as-clean shape branchDelta guards against, and the reason this returns an error instead of a Set.
function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACM']);
  if (out === null) return { error: 'git diff --cached failed — cannot tell what is staged' };
  return { files: new Set(out.split('\n').filter(Boolean)) };
}

// cm:guard drain needs a base that is not HEAD, and a push to `main` has none — origin/main IS HEAD there, so the delta is empty and every drainable file would look untouched. Freeze still runs; drain is skipped and the skip is PRINTED, because an unprinted skip reads exactly like a pass and that is how the prose gate ran over zero files while printing success.
function branchDelta() {
  const head = git(['rev-parse', 'HEAD']);
  const base = git(['merge-base', 'origin/main', 'HEAD']);
  if (!head) return { skip: 'no git HEAD' };
  if (!base) return { skip: 'no origin/main to compare against (shallow or detached checkout)' };
  if (base === head) return { skip: `merge-base is HEAD (${base.slice(0, 8)}) — no branch delta` };

  // cm:guard a git command that FAILED must not read as an empty delta. `git()` returns null on failure and `null ?? ''` is the same value as a clean tree, so a broken diff would judge zero files while the run printed that drain had been judged — the difference between "nothing to pay" and "we never looked".
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

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { files: {}, original: {} };
  try {
    const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return { files: raw.files ?? {}, original: raw.original ?? {} };
  } catch {
    return null;
  }
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

function sortDeep(files) {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, rules]) => [
        file,
        Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

const mode = process.argv[2] ?? '--all';
if (!['--all', '--staged', '--update-baseline'].includes(mode)) {
  console.error('usage: check-lint-budget.mjs [--all|--staged|--update-baseline]');
  process.exit(2);
}

const cfg = config();
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
  const previous = loadBaseline();
  if (previous === null) {
    console.error(`check-lint-budget: ${BASELINE_PATH} is unreadable — refusing to overwrite it`);
    process.exit(2);
  }
  // cm:guard a re-freeze that DELETES a scope's whole debt needs saying out loud, because that is what every bypass found in review looked like from here: 95 files and 210 frozen diagnostics gone at exit 0, accepted by `improves: down` since it only faults on a rise. Draining a scope to zero is a real achievement and must stay recordable, so this is a confirmation rather than a refusal — but never the default, and never silent.
  const emptied = emptiedScopes(
    currentByScope,
    totalsByScope(previous.files, new Map(), cfg.scopes),
  );
  // cm:guard the confirmation NAMES its scope, because one bare flag accepted both at once and deleted all 487 frozen diagnostics across 175 files at exit 0. The realistic shape is a contributor genuinely draining scope A on a branch where a config change or a bad merge emptied scope B — an unqualified yes answers a question nobody read.
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
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), original, files }, null, 2)}\n`,
  );
  console.log(
    `lint-budget baseline written: ${Object.keys(files).length} file(s), ${total(files)} violation(s) frozen`,
  );
  for (const [scope, n] of currentByScope) console.log(drainedLine(scope, n, original[scope]));
  process.exit(0);
}

const baseline = loadBaseline();
if (baseline === null) {
  console.error(`check-lint-budget: ${BASELINE_PATH} is unreadable — refusing to report clean`);
  process.exit(2);
}

// cm:guard this is the guard that does NOT enumerate, and it is why the two config-reading guards above are a second opinion rather than the defence. Whatever stops biome linting a scope — a rule set emptied, an `overrides` block, an ignore file, something biome ships next year — ends here, because a baseline holding debt against a measurement of zero is the one observable every version of the bypass shares. AC 8 word for word: zero diagnostics from a scope that should have some is an exit 2, never a clean report.
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
  staged = stagedFiles();
  if (staged.error) {
    console.error(`check-lint-budget: ${staged.error}`);
    process.exit(2);
  }
}

const failures = freezeFaults(measured, baseline.files, staged?.files ?? null);

// cm:guard drain is an --all rule only. --staged exists for a pre-commit hook (none runs it today — .githooks/pre-commit runs check-source-language and check-test-signal only) and must not judge a payment against a half-staged tree; the branch delta this measures is what CI sees, and that is where the payment is due.
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

// cm:guard one block per FILE, so the count is files-to-fix. Freeze and drain can both fault the same file — a new diagnostic in a file frozen at zero fails both — and printing it twice reported "2 file(s) failed" for one file, which is a checker overstating the work it is asking for.
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
    // cm:guard offer the re-freeze ONLY for a freeze fault. `--update-baseline` re-measures the file it is failing on, so against a drain fault it writes the unchanged count straight back and the next run fails identically — advice that cannot work reads as a broken checker, and a contributor who follows it twice concludes the gate is the bug.
    (drainFailed
      ? 'A drain has no re-freeze escape: --update-baseline re-measures the file and writes the\n' +
        'same count back, so the next run fails the same way. Remove one diagnostic.\n'
      : 'If the growth is deliberate, re-freeze it:\n' +
        '  node scripts/check-lint-budget.mjs --update-baseline\n'),
);
process.exit(1);
