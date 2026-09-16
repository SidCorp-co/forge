/**
 * ISS-1051 — the entry point for `pnpm --filter @forge/core bench:assistant`.
 *
 * The benchmark reads a deployment over HTTP and nothing else: its graders take the door's
 * fallback texts from `conversations/fallback-replies.ts`, a leaf, so this process opens no
 * database and needs none of the variables `config/env.ts` demands. `bench/cli.test.ts` runs the
 * same graph with an empty environment, which is what keeps this claim true.
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { main } from './bench/cli.js';

process.exitCode = await main(process.argv.slice(2), process.env, {
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  now: () => new Date(),
  randomId: () => randomBytes(4).toString('hex'),
});
