/**
 * A git credential is minted for the binding's one repository and never installation-wide (ISS-765
 * owner mode, and any confined agent): a binding that names no repository asked for `[]`, which
 * GitHub reads as every repository the installation was granted. It is now refused by name, and an
 * empty list is refused at the mint itself, so no caller can ask for "all" by naming none.
 */
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const asked: Array<{ repositoryNames?: string[] }> = [];
vi.mock('@octokit/auth-app', async (load) => {
  const real = await load<typeof import('@octokit/auth-app')>();
  return {
    ...real,
    createAppAuth: () => {
      const auth = async (opts: { type: string; repositoryNames?: string[] }) => {
        asked.push({ ...(opts.repositoryNames ? { repositoryNames: opts.repositoryNames } : {}) });
        return { type: 'token', token: 'ghs_planted', expiresAt: '2026-10-30T12:00:00Z' };
      };
      return Object.assign(auth, {
        hook: (request: unknown, route: unknown, params: unknown) =>
          (request as (r: unknown, p: unknown) => unknown)(route, params),
      });
    },
  };
});

const { githubGitCredential } = await import('./git-credential.js');
const { mintInstallationToken } = await import('./octokit.js');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const secrets = { appId: '1', privateKey };

beforeEach(() => {
  asked.length = 0;
});

describe('a GitHub git credential', () => {
  it('is narrowed to the binding repository', async () => {
    await githubGitCredential.mint({
      config: { installationId: 7, owner: 'sidcorp', repo: 'orbit' },
      secrets,
    });
    expect(asked).toEqual([{ repositoryNames: ['orbit'] }]);
  });

  it('is refused by name for a binding that names no repository, and nothing is minted', async () => {
    await expect(
      githubGitCredential.mint({ config: { installationId: 7, owner: 'sidcorp' }, secrets }),
    ).rejects.toThrow(/names no repository/);
    expect(asked, 'a repo-less binding minted a token').toEqual([]);
  });

  it('is never installation-wide when an empty repository list is asked for', async () => {
    await expect(
      mintInstallationToken({ appId: '1', privateKey, installationId: 8 }, []),
    ).rejects.toThrow(/names no repository/);
    expect(asked).toEqual([]);
  });
});
