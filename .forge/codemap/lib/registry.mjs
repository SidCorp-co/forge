// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// codemap/1 §8 — registry, baseline, path selection.
//
// JSON rather than YAML so the whole framework runs on a bare `node` with zero dependencies:
// a plugin that needs `npm install` before its hooks work is a plugin that gets disabled.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const SPEC_VERSION = 'codemap/1';

const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/vendor/**', '**/target/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/.turbo/**', '**/.git/**', '**/coverage/**', '**/__pycache__/**',
  '**/*.min.js', '**/*.generated.*', '**/_ide_helper*', '**/.venv/**', '**/venv/**',
  // git worktrees hold a second copy of the tree; scanning them double-counts every finding
  '**/.claude/worktrees/**', '**/*-backup-*/**', '**/storybook-static/**',
];

// cm:guard these hold whatever the registry's `exclude` says — a project onboarded by an older `cm init`
// carries that list frozen in its file, so a path that must never be scanned cannot live in the default
// alone. `.forge/codemap/**` is the vendored copy of this very tool: scanning it reports the tool's own
// annotations as the project's, and one `cm install` would flood the baseline.
const HARD_EXCLUDE = ['**/.forge/codemap/**', '**/node_modules/**', '**/.git/**'];

export const DEFAULT_REGISTRY = {
  specVersion: SPEC_VERSION,
  flows: [],
  externals: [],
  enforce: { grammar: true, include: ['**'], exclude: DEFAULT_EXCLUDE },
  languages: {},
};

export function findRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.forge')) || existsSync(join(dir, '.git'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return resolve(from);
    dir = up;
  }
}

export function loadRegistry(root) {
  const path = join(root, '.forge', 'codemap.json');
  if (!existsSync(path)) return { ...DEFAULT_REGISTRY, _missing: true, _path: path };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`.forge/codemap.json is not valid JSON: ${e.message}`);
  }
  if (raw.specVersion && raw.specVersion !== SPEC_VERSION) {
    throw new Error(
      `registry declares ${raw.specVersion} but this tool implements ${SPEC_VERSION}. ` +
      `Upgrade the plugin, or run: cm migrate --to ${SPEC_VERSION.split('/')[1]}`,
    );
  }
  return {
    ...DEFAULT_REGISTRY,
    ...raw,
    enforce: { ...DEFAULT_REGISTRY.enforce, ...(raw.enforce ?? {}) },
    languages: { ...(raw.languages ?? {}) },
    _path: path,
  };
}

export function saveRegistry(root, reg) {
  const dir = join(root, '.forge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { _missing, _path, ...clean } = reg;
  writeFileSync(join(dir, 'codemap.json'), `${JSON.stringify(clean, null, 2)}\n`);
}

const BASELINE = ['.forge', 'codemap-baseline.json'];

export function loadBaseline(root) {
  const p = join(root, ...BASELINE);
  if (!existsSync(p)) return {};
  let raw;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [file, v] of Object.entries(raw)) {
    // cm:why the pre-0.2 format stored counts, which cannot say WHICH comment is new — treat it as empty and say so
    if (!Array.isArray(v)) {
      out.__legacyFormat = true;
      continue;
    }
    out[file] = new Set(v);
  }
  return out;
}

export function saveBaseline(root, keysByFile) {
  const dir = join(root, '.forge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(keysByFile)
      .filter(([, keys]) => keys.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, keys]) => [f, [...keys].sort()]),
  );
  writeFileSync(join(root, ...BASELINE), `${JSON.stringify(sorted, null, 2)}\n`);
}

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

export function matcher(globs) {
  const res = globs.map(globToRe);
  return (p) => res.some((re) => re.test(p));
}

const hardExcluded = matcher(HARD_EXCLUDE);

export function selects(reg, relPath) {
  const inc = matcher(reg.enforce.include ?? ['**']);
  const exc = matcher(reg.enforce.exclude ?? []);
  return inc(relPath) && !exc(relPath) && !hardExcluded(relPath);
}

/** Enforcement is per-language: a Go repo enforces differently from a SQL migration tree. */
export function enforcementFor(reg, prof) {
  const perLang = reg.languages?.[prof.id] ?? {};
  const grammar = perLang.enforce ?? prof.enforce ?? reg.enforce.grammar ?? true;
  return { grammar, docPolicy: perLang.docPolicy ?? prof.docPolicy };
}

const SCAN_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|go|php|py|pyi|rs|sql|sh|bash|zsh|ya?ml|toml)$/i;

export function walk(root, reg) {
  const out = [];
  const exc = matcher(reg.enforce.exclude ?? DEFAULT_EXCLUDE);
  (function rec(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        if (exc(`${rel}/x`) || hardExcluded(`${rel}/x`)) continue;
        rec(abs);
      } else if (SCAN_EXT.test(e.name) && !exc(rel) && !hardExcluded(rel)) {
        out.push(rel);
      }
    }
  })(root);
  return out.sort();
}

/**
 * codemap/1 §7 — a scope that cannot be computed is never an empty scope.
 *
 * `execFileSync` throwing here used to surface as a raw Node stack trace under exit 1, which is the
 * same code as "violations found" — so a CI gate whose ref was missing from a shallow clone reported
 * as a lint failure. Both callers turn this into exit 2.
 */
function gitFiles(root, args, what) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = String(e.stderr ?? e.message ?? '').split('\n')[0].replace(/^fatal:\s*/, '');
    throw new Error(`cannot resolve ${what}: ${detail || 'git failed'}`);
  }
  return out.split('\n').map((s) => s.trim()).filter((s) => s && SCAN_EXT.test(s));
}

export function changedSince(root, ref) {
  return gitFiles(root, ['diff', '--name-only', '--diff-filter=ACMR', ref], `--since ${ref}`);
}

/** Staged files — what a pre-commit hook must gate on (`cm install --git-hook`). */
export function changedStaged(root) {
  return gitFiles(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], '--staged');
}

/**
 * Changed LINE ranges per file: `Map<relPath, Array<[start, end]>>`.
 *
 * `--name-only` was the whole of `--since`'s scoping, so a five-hunk change to one file reported every
 * diagnostic in it — 24 errors of which zero came from the diff. This is the `clang-tidy-diff` model,
 * and the reason those tools are adoptable on legacy code.
 *
 * A file with no entry is NOT "nothing changed": an untracked file never appears in `git diff` at all,
 * so callers must treat a missing entry as "do not filter" (see cm.mjs). Fail-closed on purpose — the
 * other way round lets an agent write a brand-new file full of prose past the hook.
 */
export function changedRanges(root, args, what) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = String(e.stderr ?? e.message ?? '').split('\n')[0].replace(/^fatal:\s*/, '');
    throw new Error(`cannot resolve ${what}: ${detail || 'git failed'}`);
  }
  const ranges = new Map();
  let file = null;
  for (const line of out.split('\n')) {
    const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plus) { file = plus[1] === '/dev/null' ? null : plus[1].trim(); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // cm:why a pure deletion is `+c,0`: it changed no line that still exists, so it contributes no range
    if (count === 0) { if (!ranges.has(file)) ranges.set(file, []); continue; }
    const arr = ranges.get(file) ?? [];
    arr.push([start, start + count - 1]);
    ranges.set(file, arr);
  }
  return ranges;
}

/**
 * Version of the tool that is actually running. Read from wherever this copy lives — the plugin's
 * manifest, or the VERSION file `cm install` stamps beside a vendored copy — so a project pinned to
 * an older vendored `cm` reports its own version rather than the plugin's.
 */
export function toolVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = resolve(here, '..', '..', '.claude-plugin', 'plugin.json');
  try { return JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown'; } catch { /* vendored */ }
  try { return readFileSync(resolve(here, '..', 'VERSION'), 'utf8').trim() || 'unknown'; } catch { return 'unknown'; }
}

/**
 * The file's content at HEAD, or null when git cannot answer (no commit, untracked, no repo).
 *
 * `cm baseline` uses it to tell "pre-existing" from "written seconds ago". null means the question is
 * unanswerable, and the caller then treats the file as new rather than as legacy.
 */
export function headBlob(root, relPath) {
  try {
    return execFileSync('git', ['-C', root, 'show', `HEAD:${relPath}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

/** Files that differ from HEAD, plus untracked ones — the only files that CAN carry a new comment. */
export function dirtyFiles(root) {
  try {
    const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(`${changed}\n${untracked}`.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return null; }
}

/** The version of the checker a repo has VENDORED (`cm install`), or null when there is none. */
export function vendoredVersion(root) {
  try { return readFileSync(join(root, '.forge', 'codemap', 'VERSION'), 'utf8').trim() || null; }
  catch { return null; }
}

/** -1 / 0 / 1, on the leading numeric triple. Unparseable input sorts equal, never "newer". */
export function compareVersions(a, b) {
  const n = (v) => String(v ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function isTracked(root, relPath) {
  return existsSync(join(root, relPath));
}
