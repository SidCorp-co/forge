// One package's typecheck as tc-changed runs it: every config the package declares, in parallel,
// each incremental against its own build-info file.
//
// A package is checked under `tsconfig.json`, its source, and under `tsconfig.test.json` where it
// has one, its source and its tests (ISS-754). Both, not the test config alone: the test config
// extends the source one but also takes in test-only global declarations (web-v2's
// `witness/*.tsx` add `Window` fields), so a source file reading one passes the test program and
// fails the build's.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
