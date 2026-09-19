#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sshResolutions } from './lib/lockfile-transport.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILE = join(ROOT, 'pnpm-lock.yaml');

if (!existsSync(LOCKFILE)) {
  console.error('lockfile-transport: pnpm-lock.yaml not found — nothing was scanned');
  process.exit(2);
}

const { scanned, offenders } = sshResolutions(readFileSync(LOCKFILE, 'utf8'));

if (scanned === 0) {
  console.error(
    'lockfile-transport: pnpm-lock.yaml holds no `resolution:` entry — the file, ' +
      'or this checker, is not reading what it thinks it is',
  );
  process.exit(2);
}

if (offenders.length === 0) {
  console.log(`lockfile-transport: ${scanned} resolution(s), none over SSH`);
  process.exit(0);
}

console.error(
  `lockfile-transport: ${offenders.length} line(s) name an SSH transport, ` +
    `of ${scanned} resolution(s) scanned\n`,
);
for (const { line, owner, text } of offenders) {
  console.error(`  pnpm-lock.yaml:${line}  ${owner}`);
  console.error(`    ${text}\n`);
}
console.error(
  'Each of these makes `pnpm install` run `git clone git@…`, which needs an SSH key.\n' +
    'No workflow here is given one, and a Dependabot-triggered workflow is given no\n' +
    'repository secret either, so the install exits 128 before any job does its own work.\n' +
    '\n' +
    'For a public GitHub repository pinned to a commit, declare it as the tarball URL\n' +
    'pnpm resolves it to anyway, which needs no credential at all:\n' +
    '  https://codeload.github.com/<owner>/<repo>/tar.gz/<commit-sha>\n' +
    'then re-run `pnpm install --lockfile-only`.\n' +
    '\n' +
    'A dependency that is genuinely private has no credential-free equivalent, and is a\n' +
    'decision to take rather than a message to reword: nothing in this CI can fetch it.',
);
process.exit(1);
