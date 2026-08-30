// The ratchet every baselined checker in this repo runs, with the analyzer removed.
//
// check-test-signal, check-lint-budget and check-size-budget all freeze
// `{path: {metric: n}}` and fail when a metric rises. Until now each carried its
// own copy of the registry read, the baseline I/O, the mode parsing and the
// comparison, and the copies did not agree: check-size-budget.mjs's own guard
// named check-lint-budget.mjs as the version it must not drift from, with
// nothing enforcing that, while check-test-signal fell back to built-in defaults
// on an absent registry and read a failed `git diff --cached` as an empty stage.
//
// What differs between checkers is the ANALYZER — which files it looks at and
// what it counts. That stays in each checker. Everything below is the part that
// was three times over.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function manifestPath(root) {
  return join(root, '.forge', 'conformance.json');
}

// cm:guard each way of failing to read the manifest says WHICH, and that is the fix it arrived with. check-lint-budget spent three review rounds on one message covering four conditions, which sent a reader to check permissions on a file that parses fine.
// cm:guard `required` is NOT a knob to standardise away. A scope list has no meaningful default — inventing one measures directories the manifest never declared — so the two biome checkers demand the file. A threshold set does: `.forge/conformance.json`'s own `$comment` promises that deleting a checker's block degrades to its built-in behaviour, which is the contract check-test-signal is held to. Same reader, two documented answers.
/** @returns `{manifest}` — `{}` for an absent file when `required` is false — or `{error}` */
export function readManifest(root, { required = true } = {}) {
  const path = manifestPath(root);
  if (!required && !existsSync(path)) return { manifest: {} };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { error: `${path} could not be read: ${err.code ?? err.message}` };
  }
  try {
    return { manifest: JSON.parse(raw) };
  } catch (err) {
    return { error: `${path} is not valid JSON: ${err.message}` };
  }
}

// cm:edge contract -> scripts/conformance-audit.mjs — R9 reads `checkers.<key>.scopes` straight out of this same manifest with `?? []` to decide which checker owns which rule. It deliberately does NOT call this function, because it must tolerate a checker having no scopes key where this must refuse; what the two share is the location, so moving where a scope list lives makes the audit and the checker disagree about what is covered.
/** The `scopes` array a biome checker registers against, fail-closed on every way it can be absent. */
export function scopeConfig(root, key) {
  const { manifest, error } = readManifest(root);
  if (error) return { error };
  const scopes = manifest?.checkers?.[key]?.scopes;
  const path = manifestPath(root);
  if (!Array.isArray(scopes)) {
    return { error: `${path} declares no checkers['${key}'].scopes array` };
  }
  if (scopes.length === 0) {
    return { error: `${path} declares an empty ${key} scope list — nothing would be measured` };
  }
  return { scopes };
}

/** A checker's block merged over its built-in defaults, per the manifest's degrade-to-defaults contract. */
export function tunedConfig(root, key, defaults) {
  const { manifest, error } = readManifest(root, { required: false });
  if (error) return { error };
  return { config: { ...defaults, ...(manifest?.checkers?.[key] ?? {}) } };
}

// cm:guard `null` for unreadable, `{}` for absent — the caller must be able to tell them apart, because reporting clean against a baseline that failed to parse is the fail-open shape these checkers exist to close. Returning an empty object for both is what check-test-signal did, and it made a corrupt baseline indistinguishable from a first run.
/** @returns the parsed doc, `{}` when the file does not exist, `null` when it exists and will not parse */
export function loadBaseline(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeBaseline(path, doc) {
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

/** Diagnostics in one file, summed across metrics. */
export function fileTotal(metrics) {
  return Object.values(metrics ?? {}).reduce((a, n) => a + (typeof n === 'number' ? n : 0), 0);
}

/** Every file's metrics, summed. `files` is the baseline/measured `{path: {metric: n}}` shape. */
export function total(files) {
  return Object.values(files ?? {}).reduce((a, metrics) => a + fileTotal(metrics), 0);
}

/**
 * Freeze: no file may hold more of a metric than its baseline allows.
 *
 * `scope` limits which files are judged (pre-commit's staged set); null judges all.
 */
// cm:guard a metric absent from the baseline reads as 0, never as exempt. That is what makes a NEW offender fail: it has no record, every metric it carries is above the implied zero, and the file faults. Defaulting an unknown metric to the measured value would make the first sighting of any rule free.
// cm:guard the BOUND on that: a measured entry whose every metric is 0 does not fault, even absent from the baseline, because nothing rose. check-test-signal relies on never producing one — `violationsFor` records a file only when `declaration/assertions >= declarationRatio` or `mock/assertions >= mockRatio`, so a recorded file always carries a non-zero metric while both ratios in .forge/conformance.json stay above 0. Tune either to 0 there and a zero-metric file becomes recordable and would pass; the caller, not this function, is where that would have to be caught. Pinned by a test in debt-ratchet.test.mjs.
export function freezeFaults(measured, baseline, scope = null) {
  const faults = [];
  for (const [file, now] of Object.entries(measured)) {
    if (scope && !scope.has(file)) continue;
    const was = baseline[file] ?? {};
    const reasons = [];
    for (const [metric, count] of Object.entries(now)) {
      const allowed = was[metric] ?? 0;
      if (count > allowed) reasons.push(`${metric}: ${count} (baseline allowed ${allowed})`);
    }
    if (reasons.length) faults.push({ file, reasons });
  }
  return faults;
}

/** Stable key order, both levels, so a re-freeze diffs as the counts that moved. */
export function sortDeep(files) {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, metrics]) => [
        file,
        Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

/** @returns `{mode}` for a recognised mode, `{error}` otherwise — the caller exits 2. */
export function parseMode(argv, allowed, script) {
  const mode = argv[2] ?? '--all';
  if (!allowed.includes(mode)) return { error: `usage: ${script} [${allowed.join('|')}]` };
  return { mode };
}

// cm:guard a failed `git diff --cached` must NOT become an empty staged set. Every caller skips files outside the set, so null-to-empty makes `--staged` print a clean report over nothing — and a pre-commit hook that reports clean because git broke is worse than one that does not run, because it is recorded as having passed.
/** @returns `{files: Set<string>}` of repo-relative staged paths, or `{error}` */
export function stagedFiles(root) {
  let out;
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return { error: 'git diff --cached failed — cannot tell what is staged' };
  }
  return { files: new Set(out.split('\n').filter(Boolean)) };
}
