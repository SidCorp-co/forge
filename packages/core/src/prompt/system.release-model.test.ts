/**
 * `formatProjectConfig` — the Project Config block every agent reads, and the one place a
 * live branch reaches an agent's prompt.
 *
 * ISS-1046: the block used to print `productionBranch` unconditionally, so 25 of the 32 fleet
 * projects handed their agent a branch name nothing promotes to. An agent that reads a branch
 * in its own config does not ask whether the project promotes to it — it merges to it. The line
 * is now rendered only under `releaseModel: 'promote'`, and the branch-detection paragraph
 * follows the same rule, or a `publish` project would be told to go detect a branch it has no
 * use for.
 *
 * Nothing asserted any of this before: `formatProjectConfig` appeared in no test in the package.
 */

import { describe, expect, it, vi } from 'vitest';

// system.ts imports db/client, which validates the environment eagerly; this suite is pure.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: { select: vi.fn() } }));

const { formatProjectConfig } = await import('./system.js');

const SENTINEL = '<detect-from-git>';

describe('the live branch reaches an agent only under `promote`', () => {
  it('prints the live branch for a promote project', () => {
    const out = formatProjectConfig('main', 'production', 'promote');
    expect(out).toContain('- baseBranch: main');
    expect(out).toContain('- liveBranch: production');
  });

  // cm:guard the two cases this rule exists for. The row KEEPS its branch — the migration does
  // not discard a real declaration — so a `publish` or `none` project reaches here with a live
  // branch present and must not have it printed.
  it.each(['publish', 'none'] as const)(
    'prints no live branch line at all under `%s`, even with a branch on the row',
    (model) => {
      const out = formatProjectConfig('main', 'production', model);
      expect(out).toContain('- baseBranch: main');
      expect(out).not.toContain('liveBranch');
      expect(out).not.toContain('production');
    },
  );

  it('never prints the retired spelling under any model', () => {
    for (const model of ['promote', 'publish', 'none'] as const) {
      expect(formatProjectConfig('main', 'production', model)).not.toContain('productionBranch');
    }
  });
});

describe('the branch-detection paragraph asks only for branches this project reads', () => {
  it('asks for detection when a promote project has no live branch', () => {
    const out = formatProjectConfig('main', null, 'promote');
    expect(out).toContain(`- liveBranch: ${SENTINEL}`);
    expect(out).toContain('Branch detection:');
  });

  // cm:guard a `publish` project with no live branch is fully configured, not half-configured.
  // Asking it to go detect one is how an agent comes to invent a promote target.
  it.each(['publish', 'none'] as const)(
    'asks for nothing under `%s` when the base branch is set, whatever the live branch is',
    (model) => {
      expect(formatProjectConfig('main', null, model)).not.toContain('Branch detection:');
      expect(formatProjectConfig('main', 'production', model)).not.toContain('Branch detection:');
    },
  );

  it('still asks for detection when the base branch itself is missing, under every model', () => {
    for (const model of ['promote', 'publish', 'none'] as const) {
      const out = formatProjectConfig(null, null, model);
      expect(out, model).toContain(`- baseBranch: ${SENTINEL}`);
      expect(out, model).toContain('Branch detection:');
    }
  });

  it('names the step-appropriate way out: a comment on drive, `forge_config` elsewhere', () => {
    expect(formatProjectConfig(null, null, 'none', 5, 'drive')).toContain('say so in a comment');
    expect(formatProjectConfig(null, null, 'none', 5, 'code')).toContain('`forge_config`');
  });
});
