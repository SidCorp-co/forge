#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const JSON_OUT = process.argv.includes('--json');

const SKIP =
  /(^|[/\\])(node_modules|\.next|dist|target|coverage|\.git|\.turbo|\.worktrees)([/\\]|$)/;
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);

const ALLOW = [
  // Every drizzle migration and its snapshots describe the schema as it was at that point.
  /^packages\/core\/drizzle\//,
  /^packages\/core\/tests\/integration\/release-axes-migration-ground\.ts$/,
  /^packages\/core\/tests\/integration\/release-axes-migration-e2e\.test\.ts$/,
  /^packages\/core\/tests\/integration\/release-axes-constraints-e2e\.test\.ts$/,
  /^packages\/core\/src\/prompt\/system\.release-model\.test\.ts$/,
  /^packages\/core\/src\/db\/retired-model-audit\.test\.ts$/,
  /^packages\/core\/src\/projects\/agent-config-schema\.ts$/,
  /^packages\/core\/src\/projects\/agent-config-doors\.test\.ts$/,
  /^packages\/core\/tests\/integration\/agent-config-doors-e2e\.test\.ts$/,
  /^packages\/core\/tests\/integration\/agent-config-shadow-keys\.test\.ts$/,
  // CHANGELOG records what shipped, including the names that stopped existing.
  /^CHANGELOG\.md$/,
  // This checker names what it hunts.
  /^scripts\/check-retired-model\.mjs$/,
];

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

export function stripComments(src) {
  let out = '';
  let i = 0;
  // 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state = 'code';
  // One frame per OPEN `${`, holding how many plain `{` are nested inside it. A template
  // substitution is code again, so `` `${'//'}` `` opens a string the scan must not read as a
  // comment, and the `}` that closes it must return to the template rather than to top-level code.
  const subs = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (subs.length > 0 && c === '{') {
        subs[subs.length - 1].depth += 1;
        out += c;
        i += 1;
        continue;
      }
      if (subs.length > 0 && c === '}') {
        const frame = subs[subs.length - 1];
        if (frame.depth === 0) {
          subs.pop();
          state = '`';
        } else {
          frame.depth -= 1;
        }
        out += c;
        i += 1;
        continue;
      }
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
    if (state === '`' && c === '$' && next === '{') {
      subs.push({ depth: 0 });
      state = 'code';
      out += '${';
      i += 2;
      continue;
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
