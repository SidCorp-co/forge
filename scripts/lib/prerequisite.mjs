import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PREREQUISITES = {
  deps: {
    what: 'workspace dependencies are not installed (no node_modules)',
    remedy: 'pnpm install --frozen-lockfile',
    paths: ['node_modules', 'packages/core/node_modules', 'packages/web-v2/node_modules'],
  },
  'archmap-resolver': {
    what:
      'archmap has no TypeScript resolver to spawn: dependency-cruiser is installed but carries no ' +
      'bin/dependency-cruise.mjs, the entry point archmap 0.1.4 walks node_modules for ' +
      '(dependency-cruiser 18.3.0 renamed it to bin/dependency-cruiser.mjs)',
    remedy:
      'locally only, and do not commit it: pnpm --filter @forge/core add -D dependency-cruiser@18.2.0 ' +
      "— the real fix is archmap's, tracked on ISS-1098",
    paths: ['node_modules/dependency-cruiser/bin/dependency-cruise.mjs'],
  },
  'observability-build': {
    what: '@forge/observability has not been built, so everything importing it fails to resolve',
    remedy: 'pnpm --filter @forge/observability build',
    paths: ['packages/observability/dist/index.js'],
  },
};

/** The declared prerequisites of `names` that are not on disk under `root`. */
export function absentPrerequisites(root, names = []) {
  return names
    .map((name) => {
      const spec = PREREQUISITES[name];
      if (!spec) return { name, what: `unknown prerequisite "${name}"`, remedy: null };
      return spec.paths.every((p) => existsSync(join(root, p))) ? null : { name, ...spec };
    })
    .filter(Boolean);
}

/** True when the OS could not start the command at all. */
export function couldNotStart(spawnResult) {
  return spawnResult?.error?.code === 'ENOENT';
}

/** One line per absent prerequisite: what is missing and the command that fixes it. */
export function remedyLines(missing) {
  return missing.map((m) => `${m.what}${m.remedy ? ` — run: ${m.remedy}` : ''}`);
}

/** The one-line aside a gate report shows in place of a verdict. */
export function blockedAside(missing) {
  const first = missing[0];
  if (!first) return 'could not run — prerequisite absent';
  const more = missing.length > 1 ? ` (+${missing.length - 1} more)` : '';
  return `could not run — ${first.what}${more}`;
}
