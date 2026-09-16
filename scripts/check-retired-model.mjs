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

import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // cm:guard the three files that RUN 0253 (and its rollback) against a real Postgres, and nothing
  // else under `tests/`.
  // They plant the pre-migration row the migration has to refuse or convert, so they must name the
  // column as it was — a test that could not write `production_branch` could not reach the state
  // 0253 starts from, and the migration's refusals would go to a verdict unproven. The constraints
  // file additionally asserts that the ROLLBACK puts `production_branch` back, which it cannot do
  // without naming it. Named one by one rather than by a `tests/` prefix: a prefix here would
  // exempt every future integration test from the audit, which is most of the surface this rule
  // exists to hold.
  /^packages\/core\/tests\/integration\/release-axes-migration-ground\.ts$/,
  /^packages\/core\/tests\/integration\/release-axes-migration-e2e\.test\.ts$/,
  /^packages\/core\/tests\/integration\/release-axes-constraints-e2e\.test\.ts$/,
  // cm:guard the one unit test that asserts the retired spelling is NOT rendered. It has to write
  // `productionBranch` to say so — an assertion that the name is absent cannot be made without
  // naming it — and the alternative, composing the token from halves at runtime, would be a source
  // scan evaded on purpose, which is worse than an exemption that says what it is. Named one by
  // one, for the same reason as the three above.
  /^packages\/core\/src\/prompt\/system\.release-model\.test\.ts$/,
  // cm:guard this checker's OWN test. Every fixture in it is a retired reader on purpose — that is
  // what it asserts the rules match — so the audit scanning it would report its own evidence as the
  // defect. The file holds fixture strings and nothing else.
  /^packages\/core\/src\/db\/retired-model-audit\.test\.ts$/,
  // CHANGELOG records what shipped, including the names that stopped existing.
  /^CHANGELOG\.md$/,
  // This checker names what it hunts.
  /^scripts\/check-retired-model\.mjs$/,
];

/** The patterns, each with the sentence a reader gets when it fires. */
// cm:why RULES and `stripComments` are exported: a checker whose own behaviour nothing asserts
// prints the same "no retired reader survives" whether it is working or broken, which is the
// failure mode conformance rule R7 exists to catch one level up. Exercised by
// `packages/core/src/db/retired-model-audit.test.ts` — core is where the suites actually run;
// `scripts/` has a lint gate and no test runner.
export const RULES = [
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

/**
 * Blank out comments, and ONLY comments, leaving every other byte and every newline in place.
 *
 * cm:why comments are stripped before the scan, for the same reason `check-memory-anchors.mjs`
 * does it: this repo writes obituaries, and every guard explaining WHY a name was retired names
 * that name. Scanning raw source would report the explanation as the defect.
 *
 * cm:guard this is a lexer and not a pair of regexes, because a regex cannot tell a comment from
 * the same characters inside a string. `const sep = '//'; const b = row.productionBranch;` made
 * the old spelling delete the rest of that line and pass a reader its own `production-branch`
 * rule exists to catch — a gate that goes green on the one input it was written for. String and
 * template CONTENTS are kept rather than blanked, because `binding-environment-sql` reads SQL
 * that only ever appears inside a template literal. Newlines are kept because the caller reports
 * `i + 1` as the line number, and a multi-line block comment replaced by one space renumbers
 * every finding below it — wrong, and wrong in silence.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  // 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      // newlines survive so the line numbering below a block comment stays true
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    // inside a string or template: copy verbatim, honouring the escape
    if (c === '\\') {
      out += c + (next ?? '');
      i += 2;
      continue;
    }
    if (c === state) state = 'code';
    out += c;
    i += 1;
  }
  return out;
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

// cm:guard `main()` runs only when this file IS the command. Without the test, importing it to
// assert its rules would scan the tree and call `process.exit`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
