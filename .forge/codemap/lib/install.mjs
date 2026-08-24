// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// `cm install` — put the tool IN the project, so the rules hold without the plugin.
//
// Until this existed, every enforcement path ran out of the plugin: the hooks are plugin hooks, and
// the CI recipe needed a `cm` that only exists once the plugin is installed for that user. A repo
// therefore had annotations and a baseline it could not check — a contributor without the plugin was
// unconstrained, and the next contributor WITH it inherited the blocking diagnostics. The registry is
// the repo's contract (§8); the checker has to be able to live there too.
//
// Vendored rather than published: the whole framework is zero-dependency by design (registry.mjs), so
// a copy under .forge/codemap is the only form that needs no network, no npm and no install step in CI.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '..');

// cm:guard read the lib directory, never a hand-kept list — a module missing from the copy is a vendored
// cm that crashes on import, and the list would have to be updated by whoever adds a file (nobody does)
const LIB = readdirSync(HERE).filter((f) => f.endsWith('.mjs')).sort();

const SHIM = `#!/bin/sh
# Vendored codemap entrypoint — regenerate with: cm install
# Resolves its own directory without readlink -f, which BSD/macOS did not always have.
d=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$d/cm.mjs" "$@"
`;

const PRE_COMMIT = `#!/bin/sh
# codemap/1 — installed by: cm install --git-hook
# Gates the staged tree only, so an unrelated legacy file can never block a commit.
exec "$(git rev-parse --show-toplevel)/.forge/codemap/cm" verify --staged --tier grammar
`;

function stamp(dest, version) {
  const src = readFileSync(dest, 'utf8');
  // cm:guard the marker must be @generated — languages.mjs skips a file whose head carries it, so the
  // vendored copy's own annotations can never be read as the project's (belt to HARD_EXCLUDE's braces)
  const marker = `// @generated codemap ${version} — vendored by \`cm install\`; edit the plugin, not this.`;
  // cm:why a shebang has to stay on line 1 or the file stops being directly executable
  const lines = src.split('\n');
  const at = lines[0]?.startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, marker);
  writeFileSync(dest, lines.join('\n'));
}

/**
 * @param {{root: string, version: string, gitHook: boolean, force: boolean}} opts
 * @returns {{dir: string, files: string[], hook: string|null, notes: string[]}}
 */
export function install({ root, version, gitHook, force }) {
  const dir = join(root, '.forge', 'codemap');
  mkdirSync(join(dir, 'lib'), { recursive: true });

  const files = [];
  copyFileSync(join(SCRIPTS, 'cm.mjs'), join(dir, 'cm.mjs'));
  stamp(join(dir, 'cm.mjs'), version);
  files.push('.forge/codemap/cm.mjs');

  for (const f of LIB) {
    const from = join(SCRIPTS, 'lib', f);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(dir, 'lib', f));
    stamp(join(dir, 'lib', f), version);
    files.push(`.forge/codemap/lib/${f}`);
  }

  // The spec is part of what is installed: every diagnostic cites a §section, and a contributor
  // without the plugin has nowhere else to read it.
  // plugin layout keeps SPEC.md a level above scripts/; a vendored copy keeps it beside cm.mjs
  const spec = [resolve(SCRIPTS, '..', 'SPEC.md'), join(SCRIPTS, 'SPEC.md')].find((p) => existsSync(p));
  if (spec && resolve(spec) !== resolve(join(dir, 'SPEC.md'))) {
    copyFileSync(spec, join(dir, 'SPEC.md'));
    files.push('.forge/codemap/SPEC.md');
  }

  writeFileSync(join(dir, 'cm'), SHIM);
  chmodSync(join(dir, 'cm'), 0o755);
  files.push('.forge/codemap/cm');

  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  files.push('.forge/codemap/VERSION');

  // cm:guard the hook that gates a TEAM has to be committed — .git/hooks is per-clone, so a repo whose
  //   only gate lives there is gated on exactly the machines that remembered to run one command
  const hooksDir = join(dir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-commit'), PRE_COMMIT);
  chmodSync(join(hooksDir, 'pre-commit'), 0o755);
  files.push('.forge/codemap/hooks/pre-commit');

  const notes = [];
  let hook = null;
  if (gitHook) {
    const gitDir = join(root, '.git');
    if (!existsSync(gitDir)) {
      notes.push('no .git here — skipped --git-hook');
    } else {
      const hooksDir = join(gitDir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      const target = join(hooksDir, 'pre-commit');
      if (existsSync(target) && !force) {
        notes.push('.git/hooks/pre-commit exists — left alone; re-run with --force, or call `.forge/codemap/cm verify --staged` from it');
      } else {
        writeFileSync(target, PRE_COMMIT);
        chmodSync(target, 0o755);
        hook = '.git/hooks/pre-commit';
        // cm:why a git hook lives in .git, which is per-clone and never committed — saying so here is the
        // difference between "the repo is gated" and "my clone is gated"
        notes.push('this copy is per-clone; the committed one at .forge/codemap/hooks/ is what gates everyone');
      }
    }
  }

  return { dir, files, hook, notes };
}
