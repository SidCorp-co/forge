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
