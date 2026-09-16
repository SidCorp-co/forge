#!/usr/bin/env node

// The retired release model, hunted where the compiler cannot look.
//
// ISS-1046 replaced `integration_bindings.environment` ('staging'|'prod') with
// `role` + `stages`, and `projects.production_branch` with `live_branch`. Every
// TYPED reader of those moved with the change, because `tsc` named each one. The
// three shapes below name NONE of them:
//
//   - raw SQL — `b.environment = 'prod'` in a `sql` template, which is a string
//     to TypeScript. `devices/release-label.ts` carried exactly this on the pool
//     and claim paths, and a stale predicate there fails by matching no row,
//     presenting as "no runner in the release pool" rather than as a schema break.
//   - an untyped property read — `(row as any).productionBranch`, or a read off a
//     `Record<string, unknown>` parsed from JSON.
//   - an inline literal union — `"staging" | "prod"` declared in a file that
//     imports nothing, which is how packages/web-v2 held seven copies of the enum
//     that the contracts change alone would not have broken.
//
// Exit 0 clean · 1 a retired name survives · 2 the check could not run.
//
// Usage:  node scripts/check-retired-model.mjs [--json]

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const JSON_OUT = process.argv.includes('--json');

// cm:guard the skip list is tested against the path RELATIVE to the repo root, never the absolute
// one: a delegated run works inside `<repo>/.worktrees/ISS-nnn`, so an absolute test matches the
// checkout's own prefix and the walk silently returns nothing. It printed "scope matched no files"
// once, which is the shape the `could not run` exit exists for — a green from a checker that scanned
// zero files is indistinguishable from a green from one that scanned the tree.
const SKIP =
  /(^|[/\\])(node_modules|\.next|dist|target|coverage|\.git|\.turbo|\.worktrees)([/\\]|$)/;
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);

/**
 * Where the retired names are still the truth and must NOT be reported.
 *
 * Each entry says why, because an allowlist with no reasons is how a gate stops
 * meaning what its row says.
 */
// cm:guard the migrations are the ONE place the old spelling is still correct: `0253_*.sql` reads
// `environment` and `production_branch` to convert them, and `0253_down.sql` writes them back. A
// migration that could not name the column it is migrating could not exist.
const ALLOW = [
  // Every drizzle migration and its snapshots describe the schema as it was at that point.
  /^packages\/core\/drizzle\//,
  // CHANGELOG records what shipped, including the names that stopped existing.
  /^CHANGELOG\.md$/,
  // This checker names what it hunts.
  /^scripts\/check-retired-model\.mjs$/,
];

/** The patterns, each with the sentence a reader gets when it fires. */
const RULES = [
  {
    id: 'binding-environment-sql',
    // `b.environment`, `integration_bindings.environment`, `"environment" text` in a sql template
    re: /\b(?:integration_bindings|\bb)\.environment\b/g,
    why: "raw SQL still reads `integration_bindings.environment`, a column ISS-1046 dropped. Nothing type-checks a `sql` template, so this matches no row rather than failing: select on `role = 'deploy' AND 'live' = ANY(stages)` instead.",
  },
  {
    id: 'binding-environment-ts',
    // `binding.environment`, `pair.binding.environment`, `row.environment` beside a provider read
    re: /\bbinding\.environment\b|\bctx\.environment\b/g,
    why: 'a binding still exposes `environment`, which ISS-1046 replaced with `role` and `stages`. Read the one the value actually meant: `role` for what the binding is FOR, `stages` for which environments a deploy binding serves.',
  },
  {
    id: 'production-branch-column',
    re: /\bproduction_branch\b|\bproductionBranch\b/g,
    why: '`production_branch` / `productionBranch` was renamed to `live_branch` / `liveBranch` by ISS-1046, and it is read ONLY under `releaseModel: "promote"` — 25 of 32 fleet projects carry a value there that nothing promotes to.',
  },
  {
    id: 'inline-environment-union',
    re: /["'](?:staging|prod)["']\s*\|\s*["'](?:staging|prod)["']/g,
    why: 'an inline `"staging" | "prod"` union is a private copy of an enum that no longer exists. web-v2 held seven of these importing nothing from contracts, so the contracts change alone broke none of them. Use `BindingRole` and `DeployStage`.',
  },
  {
    id: 'prod-binding-literal',
    re: /listActiveBindingsForEnvironment|resolveProductionDeclaration\b|\bresolveReleaseChannel\b(?!s)/g,
    why: 'this function was replaced by ISS-1046: `listActiveDeployBindingsForStage`, `resolveReleaseDeclaration` and `resolveReleaseChannels` (plural — it returns the whole live set and core never picks among it).',
  },
];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP.test(relative(ROOT, full))) continue;
    if (e.isDirectory()) walk(full, out);
    else if (EXT.has(extname(e.name))) out.push(full);
  }
  return out;
}

function stripComments(src) {
  // cm:why comments are stripped before the scan, for the same reason `check-memory-anchors.mjs`
  // does it: this repo writes obituaries, and every guard explaining WHY a name was retired names
  // that name. Scanning raw source would report the explanation as the defect.
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function main() {
  let files;
  try {
    files = walk(join(ROOT, 'packages'), []).concat(walk(join(ROOT, 'scripts'), []));
  } catch (err) {
    console.error(`check-retired-model: could not walk the tree: ${err.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error('check-retired-model: scope matched no files — the walk found nothing to scan');
    process.exit(2);
  }

  const findings = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (ALLOW.some((re) => re.test(rel))) continue;
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const code = stripComments(src);
    const lines = code.split('\n');
    for (const rule of RULES) {
      lines.forEach((line, i) => {
        rule.re.lastIndex = 0;
        if (!rule.re.test(line)) return;
        findings.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          text: line.trim().slice(0, 160),
          why: rule.why,
        });
      });
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  } else {
    console.log(`check-retired-model: ${files.length} files scanned`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}]\n    ${f.text}\n    ${f.why}`);
    }
    if (findings.length === 0) console.log('  no retired release-model reader survives');
    else console.error(`\ncheck-retired-model: ${findings.length} retired reader(s)`);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main();
