import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { makeProjectResolver } = await import('./resolve.js');
const { normalizeEnvironments } = await import('../../projects/environments.js');

const resolver = makeProjectResolver({
  baseBranch: 'main',
  releaseChain: [],
  environments: normalizeEnvironments(null),
  integrations: [],
});

describe('{{project:repo-path}} — a checkout is the device, not the project (ISS-1236)', () => {
  it('says the variable was retired and points the agent at its own working directory', () => {
    const text = resolver('repo-path') ?? '';
    expect(text).toContain('{{project:repo-path}}');
    expect(text).toContain('retired');
    expect(text).toContain('Your working directory is your checkout');
  });

  it('never renders a path, whatever the project holds', () => {
    expect(resolver('repo-path')).not.toMatch(/(^|\s)\/[\w.-]+\//);
  });
});
