#!/usr/bin/env node

/**
 * Builds both shipped images against a clean `git archive` export.
 *
 * The images COPY a narrow set of paths, so a dependency the repo grows outside that set is
 * invisible to every checker that measures the source tree and surfaces first on the deploy.
 * The export is what makes this check mean anything: a build over the working tree succeeds on
 * any file the host holds and the image does not, which is the defect class being tested for.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IMAGES = [
  { name: 'core', dockerfile: 'packages/core/Dockerfile' },
  { name: 'web-v2', dockerfile: 'packages/web-v2/Dockerfile' },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
}

function exportTree(destination) {
  const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: ROOT,
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'buffer',
  });
  if (archive.status !== 0) {
    console.error('build-images: git archive failed — is HEAD a commit?');
    return false;
  }
  const extract = spawnSync('tar', ['-x', '-C', destination], { input: archive.stdout });
  if (extract.status !== 0) {
    console.error(`build-images: could not extract the archive into ${destination}`);
    return false;
  }
  return true;
}

function uncommitted() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  if (status.status !== 0) return [];
  return status.stdout.split('\n').filter((line) => line.trim() !== '');
}

function warnIfTreeIsDirty() {
  const dirty = uncommitted();
  if (dirty.length === 0) return;
  console.warn(`build-images: HEAD is what gets built — ${dirty.length} uncommitted change(s) are`);
  console.warn('NOT in this build, so a pass here says nothing about them. Commit them first:');
  for (const line of dirty) console.warn(`  ${line}`);
  console.warn('');
}

function main() {
  if (run('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.error('build-images: no docker daemon answers here — this check needs one to run.');
    return 2;
  }

  warnIfTreeIsDirty();

  const context = mkdtempSync(join(tmpdir(), 'forge-images-'));
  try {
    if (!exportTree(context)) return 2;

    const failed = [];
    for (const { name, dockerfile } of IMAGES) {
      console.log(`\nbuild-images: ${name} (${dockerfile})`);
      const built = run('docker', ['build', '-f', dockerfile, '.'], { cwd: context });
      if (built.status !== 0) failed.push(name);
    }

    if (failed.length > 0) {
      console.error(
        `\nbuild-images: ${failed.join(' and ')} cannot be built from a clean checkout.`,
      );
      console.error(
        'A path the build reads is outside what the Dockerfile copies. Either copy it or stop',
      );
      console.error('depending on it — the deploy builds exactly this context.');
      return 1;
    }

    console.log(`\nbuild-images: ${IMAGES.length} image(s) build from a clean checkout`);
    return 0;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

process.exit(main());
