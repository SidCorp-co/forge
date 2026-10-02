import { describe, expect, it } from 'vitest';
import { registerAllIntegrations } from './register-all.js';
import { repositoryProvider } from './status-service.js';
import type { BindingWithConnection } from './store.js';

registerAllIntegrations();

const pair = (
  provider: string,
  config: Record<string, unknown>,
  opts: { active?: boolean; at?: number } = {},
): BindingWithConnection =>
  ({
    binding: {
      id: `${provider}-${opts.at ?? 0}`,
      provider,
      role: 'source',
      config,
      active: opts.active ?? true,
      createdAt: new Date(opts.at ?? 0),
    },
    connection: { active: true, config: {} },
  }) as unknown as BindingWithConnection;

describe('the repository card names the provider its host is', () => {
  it('keys a gitlab.com repository by the GitLab binding that serves it, not GitHub', () => {
    const pairs = [
      pair('github', { owner: 'acme', repo: 'app' }),
      pair('gitlab', { projectPath: 'acme/app' }, { at: 1 }),
    ];
    expect(repositoryProvider(pairs, 'gitlab.com/acme/app')).toEqual({
      provider: 'gitlab',
      label: 'GitLab',
    });
    expect(repositoryProvider(pairs, 'github.com/acme/app')).toEqual({
      provider: 'github',
      label: 'GitHub',
    });
  });

  it('names no provider where no binding reaches the declared host, or none is declared', () => {
    const pairs = [pair('github', { owner: 'acme', repo: 'app' })];
    expect(repositoryProvider(pairs, 'gitlab.com/acme/app')).toBeNull();
    expect(repositoryProvider(pairs, null)).toBeNull();
    expect(repositoryProvider([pair('coolify', {})], 'github.com/acme/app')).toBeNull();
  });
});
