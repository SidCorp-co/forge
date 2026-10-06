import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const PREREQUISITES = {
  deps: {
    what: 'workspace dependencies are not installed (no node_modules)',
    remedy: 'pnpm install --frozen-lockfile',
    paths: ['node_modules', 'packages/core/node_modules', 'packages/web-v2/node_modules'],
  },
  'archmap-resolver': {
    // The probe is the absence of ONE path, and two unrelated things empty it, so the message says
    // what was looked for rather than why it was not there. Naming one cause sent a reader chasing a
    // version that was never installed (ISS-1287).
    what:
      'archmap has no TypeScript resolver to spawn: this repository root has no ' +
      'node_modules/dependency-cruiser/bin/dependency-cruise.mjs, the entry point archmap 0.1.4 ' +
      'walks node_modules for. Two things empty that path and this probe cannot tell them apart: ' +
      'dependency-cruiser 18.3.0 renamed the bin to bin/dependency-cruiser.mjs, and a non-hoisting ' +
      'node-linker leaves the bin under the package that declares it instead of at the root',
    remedy:
      'read `ls packages/*/node_modules/dependency-cruiser/bin` first — a dependency-cruise.mjs ' +
      'there means the root is simply not hoisting, and .npmrc is what to read, not the version. ' +
      'Otherwise the installed version is not the 18.2.0 that the root package.json pins ' +
      'exactly: pnpm install --frozen-lockfile restores it. The pin holds until archmap releases ' +
      'its resolver fix (archmap ISS-10); then archmap install --force re-vendors it, and the pin ' +
      'and the dependency-cruiser ignore in .github/dependabot.yml go (ISS-1354)',
    paths: ['node_modules/dependency-cruiser/bin/dependency-cruise.mjs'],
  },
  'observability-build': {
    what: '@forge/observability has not been built, so everything importing it fails to resolve',
    remedy: 'pnpm --filter @forge/observability build',
    paths: ['packages/observability/dist/index.js'],
  },
  'contracts-build': {
    what: "@forge/contracts has not been built, so '@forge/contracts/document-patch' fails to resolve",
    remedy: 'pnpm --filter @forge/contracts build',
    paths: ['packages/contracts/dist/document-patch.js'],
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
