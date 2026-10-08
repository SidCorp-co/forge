// A native program's answer can differ between two checkouts of the same bytes, and no file holds
// why: biome loads no nested config under a path like `~/.cache/clone`. The key holds its answer.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROBE = 'var a = "x"\nif (a) {\n\tdebugger\n}\n';
const CONFIG = /(^|\/)\.?biome\.jsonc?$/;

const sha = (text) => createHash('sha256').update(text).digest('hex');

function biomeConfigs(files) {
  return files.filter((f) => CONFIG.test(f)).sort();
}

/** What biome makes of `root` as a place: per config, whether it formats that file and what it says of a probe beside it. */
export function biomeView(root, files) {
  const bin = join(root, 'node_modules', '.bin', 'biome');
  if (!existsSync(bin)) return 'biome is not installed here';
  const run = (args, input) =>
    spawnSync(bin, args, { cwd: root, encoding: 'utf8', input, env: process.env });
  const lines = biomeConfigs(files).map((config) => {
    const probe = join(root, dirname(config), 'place-probe.mjs');
    const own = run(['format', config]);
    const probed = run(['check', `--stdin-file-path=${probe}`], PROBE);
    const said = `${probed.stdout}${probed.stderr}`.split(root).join('<checkout>');
    return `${config}\0${own.status}\0${sha(said)}`;
  });
  return sha(lines.join('\n'));
}

export const BIOME = { configs: biomeConfigs, view: biomeView };
