/**
 * ISS-1186 — no code path in this repository fires a deployment on its own.
 *
 * The subject is the REFERENCE and not the import statement, because `integrations/coolify/
 * routes.ts` reaches `confirmPendingProdDeploy` through a dynamic `await import()`; the wrapper
 * `runCoolifyDeploy` is forbidden too. Non-test files only: a test dispatches nothing.
 *
 * @gate-input whole-tree
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(import.meta.dirname, '..');
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.fixture.ts', '.d.ts'];

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.claude',
  'target',
]);

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path, keep);
    return entry.isFile() && keep(path) ? [path] : [];
  });
}

function isSourceFile(path: string): boolean {
  if (TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** A path as this file's allowlists spell it, so a Windows separator cannot smuggle one past. */
function fromSrc(path: string): string {
  return relative(SRC_ROOT, path).split(sep).join('/');
}

function fromRepo(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/');
}

describe('no code path fires a deployment on its own (ISS-1186)', () => {
  /** Every way into a Coolify deployment: three dispatchers and the wrapper the doors call. */
  const DEPLOY_ENTRYPOINTS = [
    'tryDispatchCoolifyRelease',
    'dispatchCoolifyDeployDirect',
    'confirmPendingProdDeploy',
    'runCoolifyDeploy',
  ];

  /** The definition, and the three doors — each entered by a caller, none running by itself. */
  const ALLOWED_TO_NAME_A_DEPLOY = new Set([
    'pipeline/release-coolify.ts',
    'integrations/coolify/commands.ts',
    'integrations/coolify/routes.ts',
    'mcp/tools/forge-coolify-deploy.ts',
  ]);

  it('no file under packages/core/src names a deploy entrypoint but the four that may', () => {
    const offenders = walk(SRC_ROOT, isSourceFile)
      .filter((path) => !ALLOWED_TO_NAME_A_DEPLOY.has(fromSrc(path)))
      .filter((path) => {
        const src = readFileSync(path, 'utf8');
        return DEPLOY_ENTRYPOINTS.some((name) => src.includes(name));
      })
      .map(fromSrc)
      .sort();

    expect(offenders).toEqual([]);
  });

  /**
   * A file-granular allowlist would let a timer be added INSIDE a door and still pass, so the four
   * are held to a second rule: none of them may register anything that runs without being called.
   */
  const SELF_STARTERS = [
    'setInterval(',
    'setTimeout(',
    'setImmediate(',
    'queueMicrotask(',
    'process.nextTick(',
    'Promise.resolve(',
    '.then(',
    '.on(',
    'cron',
    'schedule',
  ];

  it('no file that may name a deploy also registers something that runs by itself', () => {
    const offenders = [...ALLOWED_TO_NAME_A_DEPLOY]
      .map((path) => [path, readFileSync(join(SRC_ROOT, path), 'utf8')] as const)
      .filter(([, src]) => SELF_STARTERS.some((token) => src.includes(token)))
      .map(([path]) => path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it('the four allowed files are all present, so the allowlist cannot pass by naming nothing', () => {
    const naming = new Set(
      walk(SRC_ROOT, isSourceFile)
        .filter((path) => {
          const src = readFileSync(path, 'utf8');
          return DEPLOY_ENTRYPOINTS.some((name) => src.includes(name));
        })
        .map(fromSrc),
    );

    expect([...ALLOWED_TO_NAME_A_DEPLOY].filter((path) => !naming.has(path))).toEqual([]);
  });
});

describe('the key that armed the landing deploy survives nowhere but its own retirement', () => {
  const RETIRED_KEY = 'deployOnLanding';

  /**
   * Where the retirement itself speaks. Whole files, which is what the exemption can be: none is
   * code the product runs with. A mention in a test, in the migration that deletes the key or in
   * the changelog reads nothing at runtime.
   */
  const RETIREMENT_SITES = new Set([
    'packages/core/src/pipeline/no-code-fires-a-deploy.test.ts',
    'packages/core/tests/integration/landing-deploy-key-removed-e2e.test.ts',
    'packages/core/drizzle/migrations/0305_no_code_fires_a_deploy.sql',
    'CHANGELOG.md',
    // An ADR records the decision that retired the key, for the same reason the changelog does.
    // `docs/adr/0002` landed at 2164d5b9 naming it, and this case was red on main from that commit
    // until this one: the PR was docs-only, so `changes` skipped `core` and nothing ran the guard.
    'docs/adr/0002-the-agent-cuts-the-release-tag.md',
  ]);

  it('no file outside the retirement mentions the key', () => {
    const offenders = walk(REPO_ROOT, (path) => !path.endsWith('.log'))
      .filter((path) => !RETIREMENT_SITES.has(fromRepo(path)))
      .filter((path) => {
        try {
          return readFileSync(path, 'utf8').includes(RETIRED_KEY);
        } catch {
          return false;
        }
      })
      .map(fromRepo)
      .sort();

    expect(offenders).toEqual([]);
  });
});

/**
 * ISS-1152 — nothing produces a job of type `release`, so a `jobCompleted` subscriber gating on it
 * reads like a live trigger and dispatches nothing. Removing the landing deploy must not restore
 * what the landing deploy replaced, so this scan outlives the file it was written in.
 */
describe('no subscriber gates jobCompleted on a job type nothing produces (ISS-1152)', () => {
  it('no file under packages/core/src compares a completed job type to "release"', () => {
    const offenders = walk(SRC_ROOT, isSourceFile)
      .filter((path) => {
        const src = readFileSync(path, 'utf8');
        if (!src.includes('jobCompleted')) return false;
        return /\.type\s*[!=]==\s*'release'/.test(src);
      })
      .map(fromSrc)
      .sort();

    expect(offenders).toEqual([]);
  });
});
