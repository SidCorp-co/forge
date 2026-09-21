import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assetNameForTarget,
  RUNNER_ASSET_PREFIX,
  RUNNER_CARGO_LOCK_PATH,
  RUNNER_CARGO_TOML_PATH,
  RUNNER_RELEASE_TAG_PREFIX,
  RUNNER_RELEASE_TARGETS,
  RUNNER_RELEASE_WORKFLOW_PATH,
} from './runner-release-preflight.js';

function repoRoot(): string {
  let at = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 10; hop++) {
    if (existsSync(join(at, '.github', 'workflows'))) return at;
    at = dirname(at);
  }
  throw new Error('runner-release-targets.test: no .github/workflows above this file');
}

const root = repoRoot();
const workflow = readFileSync(join(root, RUNNER_RELEASE_WORKFLOW_PATH), 'utf8');

/** Every `target: <value>` the matrix names, ignoring comments and `targets:`. */
function matrixTargets(yaml: string): string[] {
  return yaml
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => /^\s*target:\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((t): t is string => typeof t === 'string');
}

describe('the workflow this path cuts a tag for', () => {
  it('is at the path core matches a delivery on', () => {
    expect(existsSync(join(root, RUNNER_RELEASE_WORKFLOW_PATH))).toBe(true);
  });

  it('triggers on the tag prefix Forge cuts', () => {
    expect(workflow).toContain(`"${RUNNER_RELEASE_TAG_PREFIX}*"`);
  });

  it('builds exactly the targets core expects a whole release to carry', () => {
    expect([...matrixTargets(workflow)].sort()).toEqual([...RUNNER_RELEASE_TARGETS].sort());
  });

  it('names its assets the way core reads them back', () => {
    expect(workflow).toContain(`${RUNNER_ASSET_PREFIX}\${{ matrix.target }}`);
    for (const target of RUNNER_RELEASE_TARGETS) {
      expect(assetNameForTarget(target).startsWith(RUNNER_ASSET_PREFIX)).toBe(true);
    }
  });
});

describe('the two Cargo files the preflight reads', () => {
  it('are at the paths this repository actually holds them at', () => {
    expect(existsSync(join(root, RUNNER_CARGO_TOML_PATH))).toBe(true);
    expect(existsSync(join(root, RUNNER_CARGO_LOCK_PATH))).toBe(true);
  });

  it('declare the workspace version in the section the preflight scans', () => {
    const toml = readFileSync(join(root, RUNNER_CARGO_TOML_PATH), 'utf8');
    expect(toml).toContain('[workspace.package]');
    expect(/^\s*version\s*=\s*"\d+\.\d+\.\d+"/m.test(toml)).toBe(true);
  });
});
