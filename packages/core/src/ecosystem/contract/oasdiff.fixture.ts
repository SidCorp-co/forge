import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOasdiff } from './oasdiff.js';

const CACHE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'node_modules',
  '.cache',
  'oasdiff',
);

export async function pinnedOasdiff(): Promise<string> {
  if (process.env.OASDIFF_BIN) return process.env.OASDIFF_BIN;
  const bin = await fetchOasdiff(CACHE);
  process.env.OASDIFF_BIN = bin;
  return bin;
}
