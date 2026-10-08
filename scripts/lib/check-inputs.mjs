// What each `verify` check reads, so a passed verdict can be filed under the content of exactly
// that. `roots` are the paths whose files the check reads whole; `listed` are directories it only
// lists; `built` is output git ignores that it still reads; `git: true` is a check that also asks
// git about history or its base branch; `derived` is a cache the tool keeps inside a root; `blind`
// names the native programs it runs, which the trace cannot see. A check that cannot name its inputs is
// `uncached` with the reason. Over-naming costs a re-run; under-naming is refused by the trace.

/** `scripts/` bar its tests and prose: the checkers and what they import. */
const CODE = { path: 'scripts', skip: /(\.test\.[cm]?[jt]s|\.md)$/ };
/** What every check also depends on: the tools its dependencies resolve to, and what git ignores. */
const TOOLS = ['pnpm-lock.yaml', '.gitignore'];
const WORKSPACE = [
  'packages/contracts',
  'packages/core',
  'packages/observability',
  'packages/web-v2',
];
const CONFORMANCE = '.forge/conformance.json';
/** What pnpm reads to find the workspace. */
const PNPM = ['package.json', 'pnpm-workspace.yaml', '.npmrc'];
/** Where biome looks for a config above the directory it is given. */
const BIOME = [
  'biome.json',
  'biome.jsonc',
  '.biome.json',
  '.biome.jsonc',
  'packages/biome.json',
  'packages/biome.jsonc',
];
const BUILT = ['packages/contracts/dist', 'packages/observability/dist'];

const DECLARED = {
  'source-language': { roots: [CODE, CONFORMANCE, 'packages/core', 'packages/web-v2'] },
  'release-record': { roots: [CODE, 'CHANGELOG.md', '.forge/changelog-amnesty.json'], git: true },
  'test-signal': { roots: [CODE, CONFORMANCE, '.forge/test-signal-baseline.json', ...WORKSPACE] },
  'test-reachability': {
    roots: ['scripts', ...WORKSPACE, ...PNPM, '.forge/test-skips.json'],
    listed: ['packages'],
  },
  'whole-tree-gates': {
    roots: ['scripts', ...WORKSPACE, ...PNPM, 'packages/runner', '.forge', 'eslint.config.mjs'],
  },
  'flow-coverage': {
    uncached:
      'it skips whenever the integration suite left no coverage report, and that report is a build output no key here holds',
  },
  'pat-surface': { roots: [CODE, 'packages/core'] },
  'injected-doc-modes': { roots: [CODE, 'packages/core'] },
  'retired-model': { roots: ['scripts', ...WORKSPACE], listed: ['packages/runner'] },
  'status-tuples': { roots: [CODE, CONFORMANCE, ...WORKSPACE] },
  'doc-citations': { roots: ['.'], git: true },
  'honest-costs': { roots: [CODE, 'docs'] },
  archmap: { roots: ['.'] },
  'core lint': { roots: [...PNPM, ...WORKSPACE], listed: ['packages/runner'], blind: ['biome'] },
  'lint-budget': {
    roots: [CODE, CONFORMANCE, '.forge/lint-baseline.json', ...PNPM, ...WORKSPACE],
    listed: ['packages/runner'],
    git: true,
    blind: ['biome'],
  },
  'size-budget': {
    roots: [CODE, CONFORMANCE, '.forge/size-baseline.json', ...PNPM, ...WORKSPACE],
    listed: ['packages/runner'],
    blind: ['biome'],
  },
  'provider-literals': { roots: [CODE, CONFORMANCE, ...WORKSPACE] },
  'integration-declarations': {
    roots: [CODE, CONFORMANCE, 'tsconfig.json', ...PNPM, ...WORKSPACE],
    built: BUILT,
  },
  'merged-at-writers': { roots: [CODE, ...WORKSPACE] },
  'lazy-module-init': { roots: [CODE, ...WORKSPACE] },
  'scripts lint': { roots: [...PNPM, 'scripts'], listed: ['packages'], blind: ['biome'] },
  'core typecheck': {
    roots: [...PNPM, 'scripts', ...WORKSPACE],
    listed: ['packages/runner'],
    built: BUILT,
  },
  'cargo gates': {
    uncached:
      'it scopes to the runner crates this change touched and runs cargo, whose own target directory is the state it measures',
  },
  'comment-budget': { roots: ['.'] },
  'lockfile-transport': { roots: [CODE, 'pnpm-lock.yaml'] },
  'migration-order': {
    uncached:
      "its subject is every open branch's migration journal, which lives on remote refs no key here holds",
  },
  'conformance levels': { roots: ['.'], built: BUILT, git: true, blind: ['biome'] },
  'conformance audit': { roots: ['.'], built: BUILT, git: true },
};

/** The table above, with what every check depends on added to each one that is cached. */
export const INPUTS = Object.fromEntries(
  Object.entries(DECLARED).map(([label, d]) => {
    const tools = d.blind?.includes('biome') ? [...TOOLS, ...BIOME] : TOOLS;
    return [label, d.uncached ? d : { ...d, roots: [...d.roots, ...tools] }];
  }),
);

/** Every label in `checks` the table above does not decide, as the sentence that refuses it. */
export function undeclared(checks) {
  return checks
    .filter((c) => !(c.label in INPUTS))
    .map((c) => `${c.label}: \`roots\` naming what it reads, or \`uncached\` and why`);
}
