// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// Hooks run on every edit, so they must not walk a monorepo. `git grep` narrows the repo to the
// handful of files that actually carry annotations in a few milliseconds; the full walk is only a
// fallback for non-git trees.

import { execFileSync } from 'node:child_process';
import { walk, selects } from './registry.mjs';

const TAG_PATTERNS = ['cm:flow', 'cm:edge', 'cm:guard', 'cm:hack'];

export function candidateFiles(root, reg) {
  try {
    const args = ['-C', root, 'grep', '-lI', '--untracked'];
    for (const p of TAG_PATTERNS) args.push('-e', p);
    const out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => selects(reg, f));
  } catch {
    // cm:why git grep exits 1 on no match and fails outright outside a repo, so both land here
    try { return walk(root, reg).filter((f) => selects(reg, f)); } catch { return []; }
  }
}
