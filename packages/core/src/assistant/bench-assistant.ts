import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { main } from './bench/cli.js';

process.exitCode = await main(process.argv.slice(2), process.env, {
  fetch,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  writeNew: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx' }),
  stdout: console.log,
  stderr: console.error,
  now: () => new Date(),
  randomId: () => randomBytes(4).toString('hex'),
});
