/**
 * ISS-50 — a source host binding on another host than the declared repository is refused as it is
 * written: a GitLab binding on a github.com repository, and a GitHub binding on a gitlab.com one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

let declared: string | null = null;
vi.mock('../../project-config/source.js', () => ({
  readDeclaredSource: async () => ({ repository: declared, defaultBranch: 'main', setup: null }),
}));

const { gitlabIntegration } = await import('../gitlab/adapter.js');
const { githubIntegration } = await import('../github/adapter.js');

const verifyGitLab = (connectionConfig: Record<string, unknown> = {}) =>
  gitlabIntegration.adapter?.verifyBindingTarget?.({
    projectId: 'p',
    connection: { secretsEnc: null, config: connectionConfig },
    config: { projectPath: 'autoflow/core' },
    held: null,
  });
const verifyGitHub = () =>
  githubIntegration.adapter?.verifyBindingTarget?.({
    projectId: 'p',
    connection: { secretsEnc: null, config: {} },
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: 1 },
    held: null,
  });

beforeEach(() => {
  declared = null;
});

describe('a GitLab binding', () => {
  it('is refused on a project whose repository is on github.com, naming both hosts', async () => {
    declared = 'github.com/SidCorp-co/autoflow';
    const [refusal] = (await verifyGitLab()) ?? [];
    expect(refusal?.code).toBe('SOURCE_HOST_MISMATCH');
    expect(refusal?.detail).toContain('gitlab.com');
    expect(refusal?.detail).toContain('github.com');
  });

  it('is taken on gitlab.com, and on a self-hosted instance its connection names', async () => {
    declared = 'gitlab.com/autoflow/core';
    expect(await verifyGitLab()).toEqual([]);
    declared = 'git.example.org/autoflow/core';
    expect(await verifyGitLab({ baseUrl: 'https://git.example.org' })).toEqual([]);
    expect((await verifyGitLab())?.[0]?.code).toBe('SOURCE_HOST_MISMATCH');
  });

  it('is not refused on a project that declares no repository yet', async () => {
    expect(await verifyGitLab()).toEqual([]);
  });
});

describe('a GitHub binding', () => {
  it('is refused on a project whose repository is on gitlab.com', async () => {
    declared = 'gitlab.com/autoflow/core';
    expect((await verifyGitHub())?.[0]?.code).toBe('SOURCE_HOST_MISMATCH');
  });

  it('is taken on github.com', async () => {
    declared = 'github.com/SidCorp-co/forge';
    expect(await verifyGitHub()).toEqual([]);
  });
});
