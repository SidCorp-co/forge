// @direct-test-of packages/contracts/scripts/build.mjs
// @direct-test-of packages/observability/scripts/build.mjs
//
// A rebuild of @forge/contracts never leaves a reader without its dist (ISS-1254). One builder's
// tests failed mid-import while another rebuilt contracts, because the build removed dist before it
// emitted the new one. A second process reads every module of dist in a loop while a build is
// published under it: by rename, file by file, it reads each one whole and never misses one; the
// shape it replaced, dist removed and written again, is caught by the same reader.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publish, stagingDir } from '../../packages/contracts/scripts/publish-dist.mjs';

const MODULES = 120;
/** Large enough that writing one is not a single syscall, so a torn write can be seen. */
const BODY = `export const pad = '${'x'.repeat(256 * 1024)}';\n`;

/** The reader: every module of dist, over and over, until the stop file appears; then its counts. */
const READER = `
const { existsSync, readFileSync } = require('node:fs');
const [dist, stop, count] = process.argv.slice(1);
let reads = 0, missing = 0, torn = 0, ready = false;
while (!existsSync(stop)) {
  for (let i = 0; i < Number(count); i++) {
    try {
      const text = readFileSync(dist + '/m' + i + '.js', 'utf8');
      reads++;
      if (!text.endsWith('// end\\n')) torn++;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      missing++;
    }
  }
  if (!ready) { ready = true; process.stdout.write('ready\\n'); }
}
process.stdout.write(JSON.stringify({ reads, missing, torn }) + '\\n');
`;

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeBuild(dir, round) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < MODULES; i++) {
    writeFileSync(join(dir, `m${i}.js`), `// round ${round}\n${BODY}// end\n`);
  }
}

/** Start the reader over `dist` and resolve once it has read every module once. */
function startReader(dist, stop) {
  const child = spawn(process.execPath, ['-e', READER, dist, stop, String(MODULES)]);
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('ready\n')) resolve();
    });
    child.on('exit', () => reject(new Error(`the reader ended before it was ready: ${err}`)));
  });
  const counts = new Promise((resolve, reject) => {
    child.on('exit', (code) =>
      code === 0
        ? resolve(JSON.parse(out.split('\n').filter(Boolean).at(-1)))
        : reject(new Error(`the reader failed: ${err}`)),
    );
  });
  return { ready, counts };
}

/** Rebuild `dist` `rounds` times with `rebuild` while the reader reads it; the reader's counts. */
async function readWhileRebuilding(rebuild, rounds) {
  const root = mkdtempSync(join(tmpdir(), 'contracts-dist-'));
  made.push(root);
  const dist = join(root, 'dist');
  const stop = join(root, 'stop');
  writeBuild(dist, 0);
  const reader = startReader(dist, stop);
  await reader.ready;
  for (let round = 1; round <= rounds; round++) {
    rebuild(dist, round);
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(stop, '');
  return { dist, counts: await reader.counts };
}

/** The build as it is: emit into a staging directory inside dist, then publish. */
function stagedBuild(dist, round) {
  const staged = stagingDir(dist);
  writeBuild(staged, round);
  publish(staged, dist);
}

/** The build this replaced: dist removed, then written again. */
function removeThenWrite(dist, round) {
  rmSync(dist, { recursive: true, force: true });
  writeBuild(dist, round);
}

/** Observability's build before it published the same way: each module written over its old one. */
function writeInPlace(dist, round) {
  writeBuild(dist, round);
}

describe('a contracts rebuild under a reader', () => {
  it('a reader never misses a module or reads one half-written while the build publishes', async () => {
    const { dist, counts } = await readWhileRebuilding(stagedBuild, 15);
    expect(counts.reads).toBeGreaterThan(MODULES);
    expect(counts).toMatchObject({ missing: 0, torn: 0 });
    expect(readdirSync(dist).sort()).toEqual(
      Array.from({ length: MODULES }, (_, i) => `m${i}.js`).sort(),
    );
  });

  it('the old shape, dist removed and written again, is caught by the same reader', async () => {
    const { counts } = await readWhileRebuilding(removeThenWrite, 15);
    expect(counts.missing + counts.torn).toBeGreaterThan(0);
  });

  it('the shape observability had, each module written in place over dist, is caught as torn', async () => {
    const { counts } = await readWhileRebuilding(writeInPlace, 15);
    expect(counts.torn).toBeGreaterThan(0);
  });

  it('a module the new build no longer emits leaves dist, and a dead build’s staging is reaped', () => {
    const root = mkdtempSync(join(tmpdir(), 'contracts-dist-'));
    made.push(root);
    const dist = join(root, 'dist');
    writeBuild(dist, 0);
    writeFileSync(join(dist, 'gone.js'), 'export {};\n');
    mkdirSync(join(dist, '.next-999999999-abc'));
    const staged = stagingDir(dist);
    writeBuild(staged, 1);
    publish(staged, dist);
    expect(readdirSync(dist)).not.toContain('gone.js');
    expect(readdirSync(dist).filter((f) => f.startsWith('.next-'))).toEqual([]);
  });
});
