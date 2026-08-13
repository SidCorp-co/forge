#!/usr/bin/env node
// English-only source policy guard (ISS-65).
//
// Scans .ts/.tsx/.md files under packages/{web,dev,core}/src/ for
// non-ASCII Latin diacritics. Flags any non-allowlisted match with
// file:line:snippet output and exits 1.
//
// Allowlist (per-line, evaluated in order):
//   1. Brand-name literals (Pokémon, café, etc.). If every diacritic on
//      the line is part of an allowlisted brand, the line is skipped.
//      Example: const tagline = 'Built with café energy';
//   2. Language picker entries — line containing both
//      `value: '<lang-code>'` and `label:` legitimately needs the native
//      script as the label value.
//      Example: { value: 'vi', label: 'Tiếng Việt' }
//   3. `i18n-allow: <reason>` directive on the same line. Same-line scope
//      only. Reason text after the colon is required.
//      Example: throw new Error('Tài liệu'); // i18n-allow: backend error code mirrors API contract
//
// Modes:
//   --staged (default): scans STAGED content of files in `git diff --cached`.
//                       Used by .githooks/pre-commit.
//   --all:              walks packages/{web,dev,core}/src/ trees on the
//                       working tree. Used by CI lang-check job.
//
// Exit codes: 0 clean, 1 violations found, 2 invalid invocation.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// cm:why resolved from this file rather than from `git rev-parse` or cwd — the checker must work in a source tarball with no .git and when invoked from any directory. Run from elsewhere, the old git-or-cwd root walked nothing and reported "0 violations across 0 files".
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Latin-1 Supplement letters (À–ÿ) excluding the math/punctuation glyphs
// × (U+00D7) and ÷ (U+00F7), Latin Extended-A (Ā–ſ), and Vietnamese
// extension code points (Ơ ơ Ư ư + the U+1EA0–U+1EF9 block).
const NON_ENGLISH = /[À-ÖØ-öø-ſƠơƯưẠ-ỹ]/u;
const NON_ENGLISH_GLOBAL = /[À-ÖØ-öø-ſƠơƯưẠ-ỹ]/gu;

// cm:guard an unreadable config must abort, never fall back to DEFAULTS. Silently reverting to this repo's own layout is how a consuming repo gets a green run over a scope that does not exist there.
const DEFAULTS = {
  scanRoots: ['packages/web-v2/src', 'packages/dev/src', 'packages/core/src'],
  scanExts: ['.ts', '.tsx', '.md'],
  brandTokens: ['Pokémon', 'café', 'naïve', 'résumé', 'cliché', 'façade', 'jalapeño'],
};

const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULTS, ...(raw?.checkers?.['source-language'] ?? {}) };
  } catch (err) {
    console.error(`check-source-language: ${CONFIG_PATH} is unreadable — ${err.message}`);
    process.exit(2);
  }
}

const CFG = loadConfig();

const SCAN_ROOTS = CFG.scanRoots;
const SCAN_EXTS = new Set(CFG.scanExts);
/** Case-sensitive substrings. A line passes when every diacritic on it falls inside one of these. */
const BRAND_TOKENS = CFG.brandTokens;

const DIRECTIVE_RE = /(?:\/\/|\/\*|<!--)\s*i18n-allow\s*:\s*(.+)/i;
const LANG_PICKER_RE = /\bvalue\s*:\s*['"](?:vi|fr|de|es|ja|zh|ko|th|pt|it|ru|nl|sv|no|da|fi|pl|cs|tr|ar|he|hi|id|vn)['"]/;

const RED = '\x1b[31;1m';
const RESET = '\x1b[0m';

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return 'staged';
  if (args.length === 1 && (args[0] === '--staged' || args[0] === '--all')) {
    return args[0].slice(2);
  }
  return null;
}

function shouldScan(relPath) {
  const norm = relPath.split(sep).join('/');
  if (!SCAN_ROOTS.some((root) => norm.startsWith(`${root}/`))) return false;
  const dot = norm.lastIndexOf('.');
  if (dot < 0) return false;
  return SCAN_EXTS.has(norm.slice(dot));
}

function listStagedFiles() {
  let out;
  try {
    out = execFileSync(
      'git',
      ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'],
      { encoding: 'utf8' },
    );
  } catch {
    return [];
  }
  return out.split('\0').filter(Boolean).filter(shouldScan);
}

function readStaged(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function listAllFiles(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = join(root, scanRoot);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const rel = relative(root, f);
      if (shouldScan(rel)) files.push(rel);
    }
  }
  return files;
}

function isAllowed(line) {
  const directive = DIRECTIVE_RE.exec(line);
  if (directive) {
    const reason = directive[1].replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').trim();
    if (reason.length > 0) return { allowed: true, reason: 'directive' };
    return { allowed: false, reason: 'i18n-allow directive present without reason text' };
  }
  if (LANG_PICKER_RE.test(line) && /\blabel\s*:/.test(line)) {
    return { allowed: true, reason: 'language-picker' };
  }
  // Brand-name allowlist: every diacritic on the line must fall inside a
  // brand token; if even one diacritic is outside, the line fails.
  const matches = [...line.matchAll(NON_ENGLISH_GLOBAL)];
  if (matches.length === 0) return { allowed: true, reason: 'no-diacritic' };
  for (const match of matches) {
    const idx = match.index ?? 0;
    const covered = BRAND_TOKENS.some((token) => {
      let from = 0;
      while (true) {
        const at = line.indexOf(token, from);
        if (at < 0) return false;
        if (idx >= at && idx < at + token.length) return true;
        from = at + 1;
      }
    });
    if (!covered) return { allowed: false };
  }
  return { allowed: true, reason: 'brand' };
}

function highlight(line, useColor) {
  const trimmed = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  if (!useColor) return trimmed;
  return trimmed.replace(NON_ENGLISH_GLOBAL, (ch) => `${RED}${ch}${RESET}`);
}

function scanContent(file, content, violations) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!NON_ENGLISH.test(line)) continue;
    const verdict = isAllowed(line);
    if (verdict.allowed) continue;
    violations.push({
      file,
      line: i + 1,
      snippet: line,
      reason: verdict.reason,
    });
  }
}

function report(violations, mode, fileCount) {
  const useColor = process.stdout.isTTY === true;
  // cm:guard `all` walking zero files means scanRoots resolved nowhere, not that the tree is clean. Before this, invoking the script from another directory printed "0 violations across 0 files" and exited 0 — the fail-open shape the other checkers exit 2 on.
  if (mode === 'all' && fileCount === 0) {
    console.error(
      `check-source-language: no files under ${SCAN_ROOTS.join(', ')} — check ` +
        'checkers.source-language.scanRoots in .forge/conformance.json',
    );
    return 2;
  }
  if (violations.length === 0) {
    if (mode === 'all') {
      console.log(`check-source-language: 0 violations across ${fileCount} files`);
    }
    return 0;
  }
  console.error('Non-English text in source (English-only project policy):');
  for (const v of violations) {
    const snippet = highlight(v.snippet.replace(/^\s+/, ''), useColor);
    const tail = v.reason ? `  [${v.reason}]` : '';
    console.error(`  ${v.file}:${v.line}:    ${snippet}${tail}`);
  }
  console.error(
    'Fix: translate to English, or add the i18n-allow: directive on the same line if intentional.',
  );
  const fileSet = new Set(violations.map((v) => v.file));
  console.error(
    `${violations.length} violation(s) in ${fileSet.size} file(s).`,
  );
  return 1;
}

function main() {
  const mode = parseArgs(process.argv);
  if (!mode) {
    console.error('Usage: check-source-language.mjs [--staged|--all]');
    process.exit(2);
  }
  const root = ROOT;
  const violations = [];
  let fileCount = 0;
  if (mode === 'staged') {
    const files = listStagedFiles();
    fileCount = files.length;
    for (const file of files) {
      const content = readStaged(file);
      if (content == null) continue;
      scanContent(file, content, violations);
    }
  } else {
    const files = listAllFiles(root);
    fileCount = files.length;
    for (const rel of files) {
      const abs = join(root, rel);
      let content;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      scanContent(rel, content, violations);
    }
  }
  process.exit(report(violations, mode, fileCount));
}

main();
