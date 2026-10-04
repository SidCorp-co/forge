// What `pnpm verify` runs and what every CI step maps to locally — the tables scripts/verify.mjs reads.

import { join } from 'node:path';
import { ROOT } from './gate.mjs';

export const CI_PATH = join(ROOT, '.github', 'workflows', 'ci.yml');
export const COMPOSITE_PATH = join(ROOT, '.github', 'actions', 'setup-workspace', 'action.yml');

export const CHECKS = [
  {
    axis: 'language',
    label: 'source-language',
    layer: 'entry',
    reads: "each source file's own strings, judged file by file",
    cmd: ['node', 'scripts/check-source-language.mjs', '--all'],
    scanned: /across (\d+) files/,
  },
  {
    axis: 'record',
    label: 'release-record',
    layer: 'entry',
    reads: 'CHANGELOG.md against its base revision, one fixed file',
    cmd: ['node', 'scripts/check-release-record.mjs'],
    scanned: /^release-record: (\d+) entr/m,
    unit: 'release entries',
  },
  {
    axis: 'behaviour',
    label: 'test-signal',
    layer: 'entry',
    reads: "each test file's own assertions, judged file by file",
    cmd: ['node', 'scripts/check-test-signal.mjs', '--all'],
    scopeMayBeEmpty: true, // cm:hack ISS-172 until:QA phase on dev
    scanned: /^test-signal: (\d+) test file/m,
  },
  {
    axis: 'behaviour',
    label: 'test-reachability',
    layer: 'shared',
    reads: "every tracked test file against every runner's include globs",
    cmd: ['node', 'scripts/check-test-reachability.mjs'],
    scopeMayBeEmpty: true, // cm:hack ISS-172 until:QA phase on dev
    scanned: /^test-reachability: (\d+) tracked test file/m,
    needs: ['deps'],
    unit: 'test files',
  },
  {
    axis: 'behaviour',
    label: 'whole-tree-gates',
    layer: 'shared',
    reads: 'every test file for whole-tree declarations, across packages',
    cmd: ['node', 'scripts/check-whole-tree-gates.mjs'],
    scopeMayBeEmpty: true, // cm:hack ISS-172 until:QA phase on dev
    scanned: /^whole-tree-gates: (\d+) test file\(s\) read/m,
    unit: 'test files',
  },
  {
    axis: 'knowledge',
    label: 'pat-surface',
    layer: 'shared',
    reads: "every route the running app serves against the PAT fence, one route's calls at a time",
    cmd: ['node', 'scripts/check-pat-surface.mjs'],
    needs: ['deps', 'observability-build', 'contracts-build'],
    scanned:
      /^pat-surface: \d+ resource\(s\) · \d+ permission group\(s\) · \d+ covered prefix\(es\) · \d+ router file\(s\) · (\d+) route/m,
    unit: 'PAT-reachable routes',
  },
  {
    axis: 'knowledge',
    label: 'api-contracts',
    layer: 'shared',
    reads: 'every route the core app mounts and every MCP tool, against the committed contracts',
    cmd: ['node', 'scripts/check-api-contracts.mjs'],
    scanned: /^api-contracts: (\d+) route\(s\)/m,
    needs: ['deps', 'observability-build', 'contracts-build'],
    unit: 'routes',
  },
  {
    axis: 'knowledge',
    label: 'retired-model',
    layer: 'entry',
    reads: "each file's own model literals, judged file by file",
    cmd: ['node', 'scripts/check-retired-model.mjs'],
    scanned: /^check-retired-model: (\d+) files scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'status-tuples',
    layer: 'shared',
    reads:
      'status vocabularies across three packages; a subset reports clean on a tree that is not',
    cmd: ['node', 'scripts/check-status-tuples.mjs', '--all'],
    scanned: /^status-tuples: (\d+) file\(s\) scanned/m,
    unit: 'files',
  },
  {
    axis: 'knowledge',
    label: 'doc-citations',
    layer: 'shared',
    reads: "every document's citations against the files and symbols they name",
    cmd: ['node', 'scripts/check-doc-citations.mjs', '--all'],
    scanned: /^doc-citations: (\d+) document\(s\) scanned/m,
    carries: /^doc-citations worklist: (.+)$/m,
    unit: 'documents',
  },
  {
    axis: 'knowledge',
    label: 'honest-costs',
    layer: 'entry',
    reads: "each proposal document's own costs table, judged document by document",
    cmd: ['node', 'scripts/check-honest-costs.mjs'],
    scanned: /^honest-costs: (\d+) document/m,
    unit: 'documents',
  },
  {
    axis: 'relations',
    label: 'archmap',
    layer: 'shared',
    reads: 'the whole import graph against the declared architecture',
    cmd: ['./.forge/archmap/archmap', 'check'],
    exclusive: 'archmap',
    scanned: /archmap · (\d+) files/,
    needs: ['deps', 'archmap-resolver', 'observability-build', 'contracts-build'],
  },
  {
    axis: 'relations',
    label: 'module-boundaries',
    layer: 'shared',
    reads: "packages/core's whole import graph against the rules modules.json generates",
    cmd: ['node', 'scripts/check-module-boundaries.mjs'],
    scanned: /^module-boundaries: (\d+) file\(s\) cruised/m,
    needs: ['deps'],
  },
  {
    axis: 'relations',
    label: 'module-shape',
    layer: 'shared',
    reads:
      "packages/core's files, type-checked, against the table owners and kinds modules.json declares",
    cmd: ['node', 'scripts/check-module-shape.mjs'],
    scanned: /^module-shape: (\d+) file\(s\) linted/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'core lint',
    layer: 'entry',
    reads: "each file in packages/core by biome's per-file rules",
    cmd: ['pnpm', '--filter', '@forge/core', 'lint'],
    scanned: /Checked (\d+)/,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'lint-budget',
    layer: 'entry',
    reads: "each file's lint findings against its own frozen baseline entry",
    cmd: ['node', 'scripts/check-lint-budget.mjs', '--all'],
    scanned: /^lint-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'size-budget',
    layer: 'entry',
    reads: "each file's and function's length against its own frozen baseline entry",
    cmd: ['node', 'scripts/check-size-budget.mjs', '--all'],
    scanned: /^size-budget: (\d+) file/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'provider-literals',
    layer: 'entry',
    reads: "each file's own provider literals and external calls, judged file by file",
    cmd: ['node', 'scripts/check-provider-literals.mjs', '--all'],
    scanned: /^provider-literals: (\d+) file\(s\) scanned/m,
    unit: 'files',
  },
  {
    axis: 'form',
    label: 'integration-declarations',
    layer: 'shared',
    reads: 'every provider declaration against every module that implements one',
    cmd: ['node', 'scripts/check-integration-declarations.mjs', '--all'],
    scanned: /^integration-declarations: (\d+) provider\(s\) declared/m,
    needs: ['deps'],
    unit: 'providers',
  },
  {
    axis: 'relations',
    label: 'merged-at-writers',
    layer: 'shared',
    reads:
      'every writer of merged_at across the tree; a subset reports clean on a tree that is not',
    cmd: ['node', 'scripts/check-merged-at-writers.mjs', '--all'],
    scanned: /^merged-at-writers: (\d+) file\(s\) scanned/m,
  },
  {
    axis: 'form',
    label: 'lazy-module-init',
    layer: 'shared',
    reads: 'module initialisation across the import graph; the property is repo-wide',
    cmd: ['node', 'scripts/check-lazy-module-init.mjs', '--all'],
    scanned: /^lazy-module-init: (\d+) file\(s\) scanned/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'scripts lint',
    layer: 'entry',
    reads: "each file in scripts/ by biome's per-file rules",
    cmd: ['pnpm', 'exec', 'biome', 'check', 'scripts'],
    scanned: /^Checked (\d+) files/m,
    needs: ['deps'],
  },
  {
    axis: 'form',
    label: 'core typecheck',
    layer: 'shared',
    reads: 'the whole packages/core program, every file typed against every other',
    cmd: ['pnpm', '--filter', '@forge/core', 'exec', 'tsc', '--noEmit', '--extendedDiagnostics'],
    scanned: /^Files:\s+(\d+)/m,
    needs: ['deps', 'observability-build', 'contracts-build'],
  },
  {
    axis: 'runner',
    label: 'cargo gates',
    layer: 'entry',
    reads: 'the runner crates, and only when this change touched packages/runner',
    cmd: ['node', 'scripts/check-runner-gates.mjs'],
    scanned: /^runner-gates: (\d+) crate file\(s\) in scope/m,
    unit: 'crate files',
    scopeMayBeEmpty: true,
  },
  {
    axis: 'meta',
    label: 'lockfile-transport',
    layer: 'entry',
    reads: 'pnpm-lock.yaml, one fixed file',
    cmd: ['node', 'scripts/check-lockfile-transport.mjs'],
    scanned: /^lockfile-transport: (\d+) resolution\(s\), none over SSH/m,
    unit: 'resolutions',
  },
  {
    axis: 'meta',
    label: 'migration-order',
    layer: 'shared',
    reads: "every open branch's migration journal; the subject is the set, not this branch",
    cmd: ['node', 'scripts/check-migration-order.mjs'],
    scanned: /^migration-order: (\d+) migration\(s\) landing/m,
    unit: 'migrations landing',
    // 0 is the ordinary reading: most trees land no migration, and the checker says so rather
    // than reading a set it has nothing to compare against.
    scopeMayBeEmpty: true,
  },
  {
    axis: 'meta',
    label: 'conformance levels',
    layer: 'shared',
    reads: "every axis's gates and baselines against origin/main",
    cmd: ['node', 'scripts/conformance-status.mjs'],
    scanned: /^conformance-status: (\d+) axes measured/m,
    unit: 'axes',
  },
  {
    axis: 'meta',
    label: 'conformance audit',
    layer: 'shared',
    reads: 'every conformance rule across the whole tree',
    cmd: ['node', 'scripts/conformance-audit.mjs'],
    exclusive: 'archmap',
    scanned: /^conformance-audit: (\d+) rules evaluated/m,
    unit: 'rules',
  },
];

/** The parity proof every mode runs last; its layer and its scan proof are declared like any check's. */
export const CI_PARITY = {
  label: 'ci-parity',
  layer: 'entry',
  reads: 'ci.yml and the setup-workspace composite, two fixed files',
  scanned: /^ci-parity: (\d+) CI step\(s\) declared/m,
  unit: 'CI steps',
};

export const CI_COVERAGE = {
  'node scripts/check-honest-costs.mjs': 'verify',
  'node scripts/check-status-tuples.mjs --all': 'verify',
  'node scripts/check-doc-citations.mjs --all': 'verify',
  'node scripts/check-release-record.mjs': 'verify',
  'node scripts/check-retired-model.mjs': 'verify',
  'node scripts/check-pat-surface.mjs': 'verify',
  'node scripts/check-api-contracts.mjs': 'verify',
  'node scripts/check-source-language.mjs --all': 'verify',
  'node scripts/check-test-signal.mjs --all': 'verify',
  'node scripts/check-size-budget.mjs --all': 'verify',
  'node scripts/check-lint-budget.mjs --all': 'verify',
  'node scripts/check-provider-literals.mjs --all': 'verify',
  'node scripts/check-integration-declarations.mjs --all': 'verify',
  'node scripts/check-lazy-module-init.mjs --all': 'verify',
  'node scripts/check-migration-order.mjs': 'verify',
  'node scripts/conformance-status.mjs': 'verify',
  'node scripts/conformance-audit.mjs': 'verify',
  'node scripts/verify.mjs --ci-parity': 'verify, as its own final check',
  'node scripts/check-archmap-ready.mjs':
    'verify, as the `archmap-resolver` prerequisite the archmap check declares in `needs`',
  './.forge/archmap/archmap check': 'verify',
  'node scripts/check-module-boundaries.mjs': 'verify',
  'node scripts/check-module-shape.mjs': 'verify',
  'node scripts/check-test-reachability.mjs': 'verify',
  'pnpm exec biome check scripts': 'verify',
  'pnpm --filter @forge/core lint': 'verify',
  'pnpm --filter @forge/core typecheck': 'verify',
  'pnpm --filter web-v2 lint': 'verify, as the lint-budget check',
  'pnpm --filter @forge/contracts test': 'pnpm test',
  'pnpm --filter web-v2 exec vitest run --passWithNoTests': 'pnpm test',
  'pnpm --filter web-v2 build': 'pnpm build',
  'pnpm --filter @forge/core test': 'pnpm test',
  'pnpm --filter @forge/core build': 'pnpm build',
  'pnpm --filter @forge/core test:integration:ci': 'pnpm --filter @forge/core test:integration',
  'Lockfile sync + fmt + clippy + test':
    'verify, via scripts/check-runner-gates.mjs when packages/runner changed — on THIS box only, while CI runs the same step on ubuntu before the merge and on macOS and Windows after it',
  'node scripts/check-whole-tree-gates.mjs --run':
    'verify, the declarations half; pnpm test runs the declared files themselves',
  'node scripts/build-images.mjs':
    'pnpm images, which verify does NOT run — it needs a docker daemon',
  'Cross-target clippy for Windows and macOS':
    "the ubuntu runner job only — scripts/check-runner-gates.mjs clippies this box's own target",
  'Check Markdown links': 'docs job, gaurav-nelson/github-action-markdown-link-check',
  'Whether a pull_request run already proved this exact tree':
    "nothing local — it reads the event and the commit's parent count, which exist only on CI",
  'Require every CI job to have passed or been skipped': 'the ci-passed gate itself',
};

/**
 * Checks that gate a merge and have no step in `ci.yml` for `--ci-parity` to find.
 *
 * CodeQL runs from GitHub's default setup, so nothing in this tree declares it and nothing here can
 * run it. It went unnamed until an alert on a test helper held a PR whose own `ci-passed` was green
 * (ISS-1153). Named here rather than measured, because naming it is the whole of what this checkout
 * can do about it.
 */
export const OFF_TREE_CHECKS = [
  'CodeQL — no workflow file here and not runnable locally; read its alerts on the PR',
];

export const RUN_ELSEWHERE_HINT = [
  'test:integration',
  'web-v2',
  '@forge/core test',
  '@forge/core build',
  'build-images',
];
