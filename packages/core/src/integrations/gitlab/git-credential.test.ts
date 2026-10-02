/**
 * ISS-50 — the git credential a runner's helper is served for a GitLab repository: the binding's own
 * project on its own host, nothing broader, and the GitHub mint now asks the host too.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { gitlabGitCredential } = await import('./git-credential.js');
const { githubGitCredential } = await import('../github/git-credential.js');

const config = { projectPath: 'autoflow/core' };

describe('which repository a GitLab binding reaches', () => {
  it('its own project on gitlab.com, with or without .git and slashes, in any case', () => {
    expect(gitlabGitCredential.reaches(config, 'gitlab.com', 'autoflow/core.git')).toBe(true);
    expect(gitlabGitCredential.reaches(config, 'GitLab.com', '/Autoflow/Core/')).toBe(true);
  });

  it('not another project, not the same path on another host, not a nested sibling', () => {
    expect(gitlabGitCredential.reaches(config, 'gitlab.com', 'autoflow/other.git')).toBe(false);
    expect(gitlabGitCredential.reaches(config, 'github.com', 'autoflow/core.git')).toBe(false);
    expect(gitlabGitCredential.reaches(config, 'gitlab.com', 'autoflow/core/sub.git')).toBe(false);
  });

  it('a self-hosted instance through its base URL', () => {
    const own = { ...config, baseUrl: 'https://git.example.org' };
    expect(gitlabGitCredential.reaches(own, 'git.example.org', 'autoflow/core.git')).toBe(true);
    expect(gitlabGitCredential.reaches(own, 'gitlab.com', 'autoflow/core.git')).toBe(false);
  });

  it('serves only a binding naming its project by path', () => {
    expect(gitlabGitCredential.serves(config)).toBe(true);
    expect(gitlabGitCredential.serves({ projectId: 7 })).toBe(false);
  });
});

describe('what a GitLab binding mints', () => {
  it('the connection token under oauth2, good for an hour before git asks again', async () => {
    const before = Date.now();
    const got = await gitlabGitCredential.mint({ config, secrets: { token: 'glpat-x' } });
    expect(got.username).toBe('oauth2');
    expect(got.password).toBe('glpat-x');
    expect(Date.parse(got.expiresAt) - before).toBeGreaterThanOrEqual(59 * 60_000);
  });

  it('refuses a connection holding no token', async () => {
    await expect(gitlabGitCredential.mint({ config, secrets: {} })).rejects.toThrow(
      /holds no GitLab access token/,
    );
  });
});

describe('a GitHub binding asks the host as well as the path', () => {
  const gh = { owner: 'SidCorp-co', repo: 'forge', installationId: 1 };
  it('reaches its repository on github.com and not the same path on gitlab.com', () => {
    expect(githubGitCredential.reaches(gh, 'github.com', 'sidcorp-co/FORGE.git')).toBe(true);
    expect(githubGitCredential.reaches(gh, 'gitlab.com', 'SidCorp-co/forge.git')).toBe(false);
  });
});
