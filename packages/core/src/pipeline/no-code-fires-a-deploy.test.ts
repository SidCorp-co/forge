/**
 * ISS-1186 — no code path in this repository fires a deployment on its own.
 *
 * Until this landed, `pipeline/landing-deploy.ts` subscribed to `transition` and dispatched a
 * Coolify deployment the moment an issue reached `developed`: code firing a deploy, and firing it
 * before any verdict on the change existed.
 *
 * The subject is the REFERENCE and not the import statement, because `integrations/coolify/
 * routes.ts` reaches `confirmPendingProdDeploy` through a dynamic `await import()`. The wrapper
 * `runCoolifyDeploy` is forbidden beside the three dispatchers, reaching it being
 * indistinguishable from reaching past it. Non-test files only: a test dispatches nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PIPELINE_CONFIG_KEYS, pipelineConfigPatchSchema } from './pipeline-config-schema.js';

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

  /** Where the retirement itself speaks. Every other occurrence anywhere is a reader. */
  const RETIREMENT_SITES = new Set([
    'packages/core/src/pipeline/pipeline-config-schema.ts',
    'packages/core/src/pipeline/no-code-fires-a-deploy.test.ts',
    'packages/core/tests/integration/landing-deploy-key-removed-e2e.test.ts',
    'packages/core/drizzle/migrations/0305_no_code_fires_a_deploy.sql',
    'CHANGELOG.md',
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

  /** The schema's exemption is the retired-key literal, never the whole file. */
  it('the schema names the key only inside its retired-key map', () => {
    const src = readFileSync(join(SRC_ROOT, 'pipeline/pipeline-config-schema.ts'), 'utf8');
    const open = src.indexOf('RETIRED_PIPELINE_CONFIG_KEYS: Record<string, string> = {');
    expect(open).toBeGreaterThan(-1);
    const close = src.indexOf('\n};', open);
    expect(close).toBeGreaterThan(open);

    const outside = src.slice(0, open) + src.slice(close);
    expect(outside).not.toContain(RETIRED_KEY);
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

describe('a caller who names the retired key is told what replaced it (ISS-1186)', () => {
  const refusal = (body: Record<string, unknown>): string => {
    const out = pipelineConfigPatchSchema.safeParse(body);
    expect(out.success).toBe(false);
    return out.error?.issues.map((i) => i.message).join(' ') ?? '';
  };

  it('is not a key this config declares', () => {
    expect(PIPELINE_CONFIG_KEYS).not.toContain('deployOnLanding');
  });

  it('is refused by its own name, not by the generic unknown-key sentence', () => {
    const message = refusal({ deployOnLanding: true });
    expect(message).toContain('pipelineConfig.deployOnLanding no longer exists');
    expect(message).not.toContain('is not a pipeline config key');
  });

  it('says what replaced it: an agent, a tool call, and a rung that is not `developed`', () => {
    const message = refusal({ deployOnLanding: false });
    expect(message).toContain('a tool call an agent makes');
    expect(message).toContain('ISS-1186');
  });

  it('refuses it beside a key that IS declared, so one good key cannot carry it in', () => {
    const out = pipelineConfigPatchSchema.safeParse({ enabled: true, deployOnLanding: true });
    expect(out.success).toBe(false);
    expect(out.error?.issues.map((i) => i.path.join('.'))).toEqual(['deployOnLanding']);
  });

  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'answers `%s` with the unknown-key sentence, never a value off the prototype',
    (key) => {
      const message = refusal({ [key]: true });
      expect(message).toContain('is not a pipeline config key');
      expect(message).not.toContain('function');
    },
  );
});
