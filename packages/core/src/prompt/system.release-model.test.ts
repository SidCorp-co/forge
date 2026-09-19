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
