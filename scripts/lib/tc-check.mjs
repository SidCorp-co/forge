// One package's typecheck as tc-changed runs it: every config the package declares, in parallel,
// each incremental against its own build-info file.
//
// A package is checked under `tsconfig.json`, its source, and under `tsconfig.test.json` where it
// has one, its source and its tests (ISS-754). Both, not the test config alone: the test config
// extends the source one but also takes in test-only global declarations (web-v2's
// `witness/*.tsx` add `Window` fields), so a source file reading one passes the test program and
// fails the build's.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsPaths } from './direct-tests.mjs';

/**
 * Every TypeScript package under `packages/`: its directory, its name, and the workspace packages it
 * imports. A package imports another when its manifest declares it, or when a `paths` entry of its
 * tsconfig.json maps into the other's directory. The second is how `@forge/contracts` and web-v2
 * read `@forge/core/public` and `@forge/core/admin-types`: no manifest declares core, so a selection
 * read off manifests alone typechecked core by itself when core's public surface changed, and the
 * contracts and web-v2 files built on it broke after the merge (ISS-1254).
 */
export function workspacePackages(root) {
  const found = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/${d.name}`)
    .filter(
      (dir) =>
        existsSync(join(root, dir, 'tsconfig.json')) && existsSync(join(root, dir, 'package.json')),
    )
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      return {
        dir,
        name: manifest.name,
        deps: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
      };
    });
  const nameOfDir = new Map(found.map((p) => [p.dir, p.name]));
  const names = new Set(nameOfDir.values());
  return found.map((p) => {
    const mapped = tsPaths(root, p.dir)
      .map(({ target }) => nameOfDir.get(/^packages\/[^/]+/.exec(target)?.[0]))
      .filter((name) => name && name !== p.name);
    const imports = [...new Set([...p.deps.filter((d) => names.has(d)), ...mapped])];
    return { dir: p.dir, name: p.name, imports };
  });
}

/**
 * What a change typechecks: `touched`, the packages holding a changed file (every one when the
 * lockfile changed); `selected`, those and every package importing one of them, transitively; and
 * `consumers`, the selected packages that import another selected one — every importer of a touched
 * package, and a touched package that imports another touched one. `pnpm verify` checks the
 * consumers, the half of a shape change its author's own package does not see.
 */
export function selectPackages(packages, changed) {
  const lockChanged = changed.includes('pnpm-lock.yaml');
  const touched = packages.filter(
    (p) => lockChanged || changed.some((f) => f.startsWith(`${p.dir}/`)),
  );
  const selected = new Set(touched);
  for (let grew = true; grew; ) {
    grew = false;
    const names = new Set([...selected].map((p) => p.name));
    for (const p of packages) {
      if (!selected.has(p) && p.imports.some((d) => names.has(d))) {
        selected.add(p);
        grew = true;
      }
    }
  }
  const touchedNames = new Set(touched.map((p) => p.name));
  const selectedNames = new Set([...selected].map((p) => p.name));
  const consumers = [...selected].filter((p) =>
    p.imports.some((d) => (touchedNames.has(p.name) ? touchedNames : selectedNames).has(d)),
  );
  return { touched, selected: [...selected], consumers };
}

/** The configs a package is typechecked under, in order: the source, then the tests where declared. */
export const CONFIGS = ['tsconfig.json', 'tsconfig.test.json'];

/** The configs the package at `dir` (relative to `root`) declares, of {@link CONFIGS}. */
export function configsOf(root, dir) {
  return CONFIGS.filter((c) => existsSync(join(root, dir, c)));
}

/**
 * Typecheck one package under each config it declares. Answers one result per config:
 * `{ p, config, code, out, seconds }`, `code` being the compiler's exit status (0 clean) and `out`
 * its diagnostics, which name each file relative to `root` and its `TSnnnn` code.
 */
export function typecheckPackage(root, p, { bin, engine, cacheDir }) {
  const name = p.dir.split('/').pop();
  return Promise.all(
    configsOf(root, p.dir).map(
      (config) =>
        new Promise((done) => {
          const started = Date.now();
          const flavour = config === 'tsconfig.json' ? '' : `.${config.split('.')[1]}`;
          const buildInfo = join(cacheDir, `${name}${flavour}.${engine}.tsbuildinfo`);
          const child = spawn(
            bin,
            [
              '--noEmit',
              '-p',
              join(p.dir, config),
              '--incremental',
              '--tsBuildInfoFile',
              buildInfo,
            ],
            { cwd: root },
          );
          let out = '';
          child.stdout.on('data', (b) => (out += b));
          child.stderr.on('data', (b) => (out += b));
          child.on('error', (e) => (out += `${e.message}\n`));
          child.on('close', (code) =>
            done({
              p,
              config,
              code: code ?? 1,
              out,
              seconds: ((Date.now() - started) / 1000).toFixed(1),
            }),
          );
        }),
    ),
  );
}
