// @generated codemap 0.13.0 — vendored by `cm install`; edit the plugin, not this.
// Which `cm` the hooks drive.
//
// The project's own copy wins. A repo that ran `cm install` carries the tool it was onboarded with,
// so its registry, its baseline and its CI all agree with what the edit hook enforces — and a
// contributor whose plugin is a version ahead (or behind) cannot change the verdict on that repo.
// The plugin's bundled copy is the fallback, which is what keeps the plugin useful in a tree that
// has never been onboarded.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VENDORED = join('.forge', 'codemap', 'cm.mjs');

/** @returns {{path: string, source: 'project'|'plugin'}} */
export function resolveCm(root) {
  const vendored = join(root, VENDORED);
  if (existsSync(vendored)) return { path: vendored, source: 'project' };
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cm.mjs');
  return { path: bundled, source: 'plugin' };
}
