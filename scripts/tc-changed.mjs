#!/usr/bin/env node
// Typecheck the workspace packages this branch touched against its base, plus every package that
// imports one of them, in parallel and incrementally. Workspace imports resolve to source through
// each tsconfig's `paths`, so nothing has to be built first.
//
//   pnpm tc:changed                 against origin/dev
//   pnpm tc:changed --base <ref>    against another ref
//   pnpm tc:changed --all           every package
//   pnpm tc:changed --tsc           TypeScript 5 tsc instead of tsgo

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dieAs, ROOT } from './lib/gate.mjs';

const die = dieAs('tc-changed');

const args = process.argv.slice(2);

const known = new Set(['--base', '--all', '--tsc']);
for (const [i, arg] of args.entries()) {
  if (arg.startsWith('--') && !known.has(arg))
    die(`unknown flag ${arg}; takes --base <ref>, --all, --tsc`);
  if (!arg.startsWith('--') && args[i - 1] !== '--base') die(`unexpected argument ${arg}`);
}
const baseAt = args.indexOf('--base');
const base = baseAt === -1 ? 'origin/dev' : args[baseAt + 1];
if (!base || base.startsWith('--')) die('--base needs a ref');
const engine = args.includes('--tsc') ? 'tsc' : 'tsgo';

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) die(`git ${a.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `packages/${d.name}`)
  .filter(
    (dir) =>
      existsSync(join(ROOT, dir, 'tsconfig.json')) && existsSync(join(ROOT, dir, 'package.json')),
  )
  .map((dir) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    return {
      dir,
      name: manifest.name,
      deps: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
    };
  });

let selected;
if (args.includes('--all')) {
  selected = new Set(packages);
} else {
  const mergeBase = git('merge-base', base, 'HEAD');
  const changed = [
    ...git('diff', '--name-only', mergeBase).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean);
  const lockChanged = changed.includes('pnpm-lock.yaml');
  selected = new Set(
    packages.filter((p) => lockChanged || changed.some((f) => f.startsWith(`${p.dir}/`))),
  );
  const touched = [...selected].map((p) => p.name);
  for (let grew = true; grew; ) {
    grew = false;
    const names = new Set([...selected].map((p) => p.name));
    for (const p of packages) {
      if (!selected.has(p) && p.deps.some((d) => names.has(d))) {
        selected.add(p);
        grew = true;
      }
    }
  }
  const dependents = [...selected].map((p) => p.name).filter((n) => !touched.includes(n));
  console.log(
    `tc-changed: against ${base} (${mergeBase.slice(0, 9)}): touched ${touched.join(', ') || 'none'}` +
      (dependents.length ? `; importers ${dependents.join(', ')}` : ''),
  );
}
if (!selected.size) {
  console.log('tc-changed: no TypeScript package changed, nothing to check');
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

const check = (p) =>
  new Promise((done) => {
    const started = Date.now();
    const buildInfo = join(cacheDir, `${p.dir.split('/').pop()}.${engine}.tsbuildinfo`);
    const child = spawn(
      bin,
      [
        '--noEmit',
        '-p',
        join(p.dir, 'tsconfig.json'),
        '--incremental',
        '--tsBuildInfoFile',
        buildInfo,
      ],
      { cwd: ROOT },
    );
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('close', (code) =>
      done({ p, code, out, seconds: ((Date.now() - started) / 1000).toFixed(1) }),
    );
  });

const results = await Promise.all([...selected].map(check));
for (const { p, code, out, seconds } of results) {
  console.log(`tc-changed: ${p.name} ${code === 0 ? 'ok' : 'FAILED'} in ${seconds}s (${engine})`);
  if (code !== 0) process.stdout.write(out);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
