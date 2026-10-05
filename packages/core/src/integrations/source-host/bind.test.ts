import { describe, expect, it, vi } from 'vitest';

let declared: string | null = null;
vi.mock('../index.js', () => ({
  forgeReads: () => ({ declaredRepository: async () => declared }),
}));

const { sourceHostMismatch } = await import('./bind.js');
const P = '00000000-0000-4000-8000-000000000003';

describe('sourceHostMismatch: a host binding against the declared repository', () => {
  it('refuses a host binding on a local-path repository, saying what a local path cannot carry', async () => {
    declared = '/srv/git/epodsystem-core.git';
    const [r] = await sourceHostMismatch({ projectId: P, provider: 'gitlab', host: 'gitlab.com' });
    expect(r?.code).toBe('SOURCE_REPOSITORY_LOCAL');
    expect(r?.detail).toContain('webhooks');
    expect(r?.detail).toContain('merge detection');
  });

  it('takes an SSH-declared repository as served by its host', async () => {
    declared = 'git@gitlab.com:sidcorp-internal/webauto';
    expect(
      await sourceHostMismatch({ projectId: P, provider: 'gitlab', host: 'gitlab.com' }),
    ).toEqual([]);
    const [r] = await sourceHostMismatch({ projectId: P, provider: 'github', host: 'github.com' });
    expect(r?.code).toBe('SOURCE_HOST_MISMATCH');
    expect(r?.detail).toContain('on gitlab.com');
  });
});
