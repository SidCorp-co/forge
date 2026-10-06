// @gate-input whole-tree — it loads the core and web-v2 unit configs, and the job running it is core.
//
// Each package's unit config takes a share of the box's cores unless VITEST_MAX_WORKERS names a
// count; anything but a positive whole number is refused by name where the config loads, never
// silently read as the default (packages/core/vitest.config.ts, packages/web-v2/vitest.config.ts).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const VITEST = join(
  dirname(createRequire(join(ROOT, 'packages/core/package.json')).resolve('vitest/package.json')),
  'vitest.mjs',
);
const MALFORMED = ['abc', '0', '-2', '2.5', ' 4', '0x4', '1e1', 'Infinity'];

/** Loads one unit config under VITEST_MAX_WORKERS=value; a filter no file matches keeps it short. */
async function load(pkg, value) {
  const env = { VITEST_MAX_WORKERS: value };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VITEST')) env[k] ??= v;
  const args = [VITEST, 'run', '--config', 'vitest.config.ts', '--passWithNoTests', 'no-such-file'];
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, {
      cwd: join(ROOT, pkg),
      env,
      timeout: 60_000,
    });
    return { status: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { status: e.code, out: `${e.stdout}${e.stderr}` };
  }
}

describe.each(['packages/core', 'packages/web-v2'])('%s/vitest.config.ts', (pkg) => {
  it.concurrent.each(MALFORMED)(
    'refuses VITEST_MAX_WORKERS=%j by name',
    async (value) => {
      const run = await load(pkg, value);
      expect(run.out).toContain(
        `VITEST_MAX_WORKERS="${value}" is not a worker count for ${pkg}/vitest.config.ts. ` +
          'It takes a positive whole number such as 4',
      );
      expect(run.status).toBe(1);
    },
    90_000,
  );

  it.concurrent.each(['3', ''])(
    'loads with VITEST_MAX_WORKERS=%j',
    async (value) => {
      const run = await load(pkg, value);
      expect(run.out).not.toMatch(/is not a worker count/);
      expect(run.status).toBe(0);
    },
    90_000,
  );
});
