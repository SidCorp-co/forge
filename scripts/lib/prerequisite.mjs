// What a gate needs on disk before it can answer anything at all.
//
// A gate asserts ONE proposition: this rule holds over the code. It can assert
// it only when the tool that measures it exists. When the tool is absent the
// honest answer is a third thing — not "the rule holds", not "the rule is
// broken", but "I could not run" — and it has to say which, because a reader
// who cannot tell them apart acts on the wrong one.
//
// Measured 2026-09-07 in a fresh worktree with no `node_modules`: `pnpm verify`
// reported `FAIL R7 the relations gate can resolve the graph it claims to
// cover` and `conformance: claims "hardened" and does not meet it`. Both are
// claims ABOUT THE REPO, and both were false; `archmap` and `tsc` were simply
// not on disk. The signal had no field in which to say so, and unlike
// contention this survives a serial re-run identically — so it wears the exact
// signature every dispatch brief tells a reader to trust as a real defect.
//
// The remedy is named because the reader is standing in a checkout where the
// usual next step has not happened yet.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// cm:guard every entry resolves against the FILESYSTEM, never against a tool's output text. A missing binary and a broken import both print `Cannot find module`, so classifying by message would turn a real repo defect into "could not run" — the inverse of this bug and strictly worse, because it goes green. A prerequisite is absent when a path is absent, and that is the whole test.
export const PREREQUISITES = {
  deps: {
    what: 'workspace dependencies are not installed (no node_modules)',
    remedy: 'pnpm install --frozen-lockfile',
    paths: ['node_modules', 'packages/core/node_modules', 'packages/web-v2/node_modules'],
  },
  // cm:edge naming -> packages/observability/package.json — the `main`/`exports` target that packages importing @forge/observability resolve to; a build-output rename here reports the workspace as unbuilt forever
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

// cm:guard this is a STRUCTURAL signal — node telling us it could not start the process — not a match on what the process printed. Keep it that way for the same reason the table above resolves paths: the moment it reads stderr, a compile error that mentions a missing module becomes "could not run".
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
