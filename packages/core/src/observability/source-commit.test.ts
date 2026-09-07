import { afterEach, describe, expect, it, vi } from 'vitest';

// cm:why the value is a module-load constant, so each case sets the env var and resets the registry before importing; a `beforeEach` cannot serve this because every case needs a different environment in place before evaluation.
const load = async (value: string | undefined): Promise<string | null> => {
  if (value === undefined) delete process.env.SOURCE_COMMIT;
  else process.env.SOURCE_COMMIT = value;
  vi.resetModules();
  const mod = await import('./source-commit.js');
  return mod.sourceCommit;
};

describe('sourceCommit', () => {
  afterEach(() => {
    delete process.env.SOURCE_COMMIT;
  });

  it('is the SHA the build was given', async () => {
    await expect(load('3dee4d1f24ed2733f22065ab3f7caf921585a904')).resolves.toBe(
      '3dee4d1f24ed2733f22065ab3f7caf921585a904',
    );
  });

  it('accepts a short SHA and trims surrounding whitespace', async () => {
    await expect(load('  3dee4d1f\n')).resolves.toBe('3dee4d1f');
  });

  // cm:why every row here is a value a real build can hand us and a passthrough implementation returns as an identity: Coolify's application row says `git_commit_sha=HEAD`, an absent build arg reaches `ENV SOURCE_COMMIT=` as the empty string, and a compose file missing the `:-` default delivers the literal `${SOURCE_COMMIT}`.
  it.each([
    ['not told at all', undefined],
    ['the empty string', ''],
    ['whitespace', '   '],
    ['the literal HEAD', 'HEAD'],
    ['an unexpanded reference', '${SOURCE_COMMIT}'],
    ['unknown', 'unknown'],
    ['six digits', 'abc123'],
    ['forty-one digits', `${'a'.repeat(41)}`],
    ['a tag rather than a hash', 'v0.3.0'],
  ])('reports %s as missing', async (_label, value) => {
    await expect(load(value)).resolves.toBeNull();
  });
});
