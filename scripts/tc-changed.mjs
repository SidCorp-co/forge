#!/usr/bin/env node
// Typecheck the workspace packages this branch touched against its base, plus every package that
// imports one of them, in parallel and incrementally. A package imports another by its manifest or by
// a tsconfig `paths` entry into it (`lib/tc-check.mjs:workspacePackages`), so a change to core's
// public surface reaches the contracts and web-v2 files built on it. Workspace imports resolve to
// source through each tsconfig's `paths`, so nothing has to be built first. Each package is checked
// under its tsconfig.json (the source) and its tsconfig.test.json where it has one (source and
// tests), so a type error confined to a test file is red here, before a merge (ISS-754).
//
//   pnpm tc:changed                  against the branch this lands on (`lib/base-branch.mjs`)
//   pnpm tc:changed --base <ref>     against another ref
//   pnpm tc:changed --consumers      only the packages importing what changed (`pnpm verify`'s half)
//   pnpm tc:changed --all            every package
//   pnpm tc:changed --tsc            TypeScript 5 tsc instead of tsgo

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { baseRef } from './lib/base-branch.mjs';
import { dieAs, ROOT } from './lib/gate.mjs';
import { selectPackages, typecheckPackage, workspacePackages } from './lib/tc-check.mjs';

const die = dieAs('tc-changed');

const args = process.argv.slice(2);

const known = new Set(['--base', '--all', '--consumers', '--tsc']);
for (const [i, arg] of args.entries()) {
  if (arg.startsWith('--') && !known.has(arg))
    die(`unknown flag ${arg}; takes --base <ref>, --all, --consumers, --tsc`);
  if (!arg.startsWith('--') && args[i - 1] !== '--base') die(`unexpected argument ${arg}`);
}
if (args.includes('--all') && args.includes('--consumers'))
  die('--all and --consumers name two different selections; pass one');
const baseAt = args.indexOf('--base');
let base = baseAt === -1 ? null : args[baseAt + 1];
if (baseAt !== -1 && (!base || base.startsWith('--'))) die('--base needs a ref');
if (base === null && !args.includes('--all')) {
  const target = baseRef(ROOT);
  if (target.refusal) die(`no base to measure against: ${target.refusal}`);
  base = target.ref;
}
const engine = args.includes('--tsc') ? 'tsc' : 'tsgo';

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) die(`git ${a.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const packages = workspacePackages(ROOT);

let selected;
if (args.includes('--all')) {
  selected = packages;
} else {
  const mergeBase = git('merge-base', base, 'HEAD');
  const changed = [
    ...git('diff', '--name-only', mergeBase).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean);
  const choice = selectPackages(packages, changed);
  const touched = choice.touched.map((p) => p.name);
  const importers = choice.selected.filter((p) => !touched.includes(p.name));
  const why = (p) =>
    `${p.name} (imports ${p.imports.filter((d) => choice.selected.some((s) => s.name === d)).join(', ')})`;
  console.log(
    `tc-changed: against ${base} (${mergeBase.slice(0, 9)}): touched ${touched.join(', ') || 'none'}` +
      (importers.length ? `; importers ${importers.map(why).join(', ')}` : ''),
  );
  if (args.includes('--consumers')) {
    selected = choice.consumers;
    // the count line `pnpm verify` reads as this check's scope: zero is a change nothing imports
    console.log(
      `tc-changed: ${selected.length} consumer package(s) of what changed${selected.length ? `: ${selected.map((p) => p.name).join(', ')}` : ''}`,
    );
  } else {
    selected = choice.selected;
  }
}
if (!selected.length) {
  console.log('tc-changed: no TypeScript package to check');
  process.exit(0);
}

const lockfile = join(ROOT, 'pnpm-lock.yaml');
const installed = join(ROOT, 'node_modules', '.modules.yaml');
if (!existsSync(installed) || statSync(installed).mtimeMs < statSync(lockfile).mtimeMs) {
  console.log('tc-changed: node_modules is missing or older than pnpm-lock.yaml, installing');
  const r = spawnSync(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) die('pnpm install failed (see above)');
}

const bin = join(ROOT, 'node_modules', '.bin', engine);
if (!existsSync(bin)) die(`${bin} is missing; run pnpm install at ${ROOT}`);

const cacheDir = resolve(ROOT, git('rev-parse', '--git-path', 'forge-tc'));
mkdirSync(cacheDir, { recursive: true });

const results = (
  await Promise.all(selected.map((p) => typecheckPackage(ROOT, p, { bin, engine, cacheDir })))
).flat();
for (const { p, config, code, out, seconds } of results) {
  console.log(
    `tc-changed: ${p.name} ${config} ${code === 0 ? 'ok' : 'FAILED'} in ${seconds}s (${engine})`,
  );
  if (code !== 0) process.stdout.write(out);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
