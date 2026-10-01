import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

import { GitHubClientError, type GitHubRepoClient } from '../integrations/github/client.js';
import { encryptSecret } from '../integrations/vault.js';
import {
  type DeployKeyRow,
  type LiveSourceDeps,
  readProjectDivergence,
  resolveLiveSource,
} from './live-source.js';

const client = { fullName: 'SidCorp-co/forge' } as GitHubRepoClient;
const GITLAB = 'gitlab.com/thanhnguyen21/sid-desk';
const GITLAB_SSH = 'git@gitlab.com:thanhnguyen21/sid-desk.git';
let keyEnc: Buffer;

beforeAll(() => {
  keyEnc = encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nsid-desk\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function noBinding(): Promise<GitHubRepoClient> {
  throw new GitHubClientError('no_binding', 'this project has no active GitHub binding');
}

function deps(over: Partial<LiveSourceDeps> & { row?: DeployKeyRow }): LiveSourceDeps {
  return {
    githubClient: over.githubClient ?? (async () => noBinding()),
    deployKey:
      over.deployKey ?? (async () => over.row ?? { repository: GITLAB, privateKeyEnc: keyEnc }),
  };
}

describe('resolveLiveSource', () => {
  it('reads through the GitHub App where the project has an active binding', async () => {
    const deployKey = vi.fn();
    const s = await resolveLiveSource('p', deps({ githubClient: async () => client, deployKey }));
    expect(s).toEqual({ kind: 'binding', client });
    expect(deployKey).not.toHaveBeenCalled();
  });

  it('refuses in GitHub’s words a binding that exists and cannot be used, without the deploy key', async () => {
    const deployKey = vi.fn();
    const s = await resolveLiveSource(
      'p',
      deps({
        githubClient: async () => {
          throw new GitHubClientError(
            'no_installation',
            'the GitHub App is not installed on SidCorp-co',
          );
        },
        deployKey,
      }),
    );
    expect(s).toEqual({ kind: 'refused', reason: 'the GitHub App is not installed on SidCorp-co' });
    expect(deployKey).not.toHaveBeenCalled();
  });

  it('reads the declared repository over SSH with the decrypted deploy key where the project has no binding', async () => {
    const s = await resolveLiveSource('p', deps({}));
    expect(s).toEqual({
      kind: 'deploy_key',
      repoUrl: GITLAB_SSH,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsid-desk\n',
    });
  });

  it('tells a GitLab-hosted project with no key where to attach one, and never to bind GitHub', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({ row: { repository: GITLAB, privateKeyEnc: null } }),
    );
    expect(s.kind).toBe('refused');
    const reason = s.kind === 'refused' ? s.reason : '';
    expect(reason).toBe(
      "Forge holds no GitHub binding and no deploy key for this project's repository on gitlab.com, so it cannot read the branches — attach a deploy key under the project's Settings → Runners → Git access",
    );
    expect(reason).not.toMatch(/GitHub repository|Integrations/);
  });

  it('offers a GitHub-hosted project with neither the binding as well as the key', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({ row: { repository: 'github.com/SidCorp-co/forge', privateKeyEnc: null } }),
    );
    expect(s.kind === 'refused' && s.reason).toMatch(
      /on github\.com, .*Git access, or bind the repository on its Integrations page$/,
    );
  });

  it('refuses a project whose document declares no repository, naming the key to set', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({ row: { repository: null, privateKeyEnc: keyEnc } }),
    );
    expect(s.kind === 'refused' && s.reason).toMatch(
      /its document declares no repository, .*`source\.git\.repository`/,
    );
  });

  it('refuses a key the vault cannot decrypt', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({
        row: { repository: GITLAB, privateKeyEnc: Buffer.from('not a vault ciphertext at all') },
      }),
    );
    expect(s.kind === 'refused' && s.reason).toMatch(/could not be decrypted/);
  });

  it('refuses where this Forge has no vault to read the key with', async () => {
    vi.stubEnv('INTEGRATION_MASTER_KEY', '');
    const s = await resolveLiveSource('p', deps({}));
    expect(s.kind === 'refused' && s.reason).toMatch(/no secret vault configured/);
  });
});

describe('readProjectDivergence', () => {
  const refs = { baseRef: 'staging', liveRef: 'master' };
  const measured = {
    ok: true as const,
    baseSha: 'b',
    liveSha: 'l',
    aheadBy: 0,
    commits: [],
    complete: true,
  };

  it('reads through the source the project holds', async () => {
    const github = vi.fn(async () => measured);
    const deployKey = vi.fn(async () => ({ ...measured, baseSha: 'from-git' }));
    const key = { kind: 'deploy_key' as const, repoUrl: GITLAB_SSH, privateKey: 'k' };
    const viaGit = await readProjectDivergence('p', refs, {
      source: async () => key,
      github,
      deployKey,
    });
    expect(viaGit).toMatchObject({ ok: true, baseSha: 'from-git' });
    expect(deployKey).toHaveBeenCalledWith(key, refs);
    expect(github).not.toHaveBeenCalled();

    const viaApp = await readProjectDivergence('p', refs, {
      source: async () => ({ kind: 'binding', client }),
      github,
      deployKey,
    });
    expect(viaApp).toBe(measured);
    expect(github).toHaveBeenCalledWith(client, refs);
  });

  it('answers a refused source as a refusal carrying its reason', async () => {
    const d = await readProjectDivergence('p', refs, {
      source: async () => ({ kind: 'refused', reason: 'no key' }),
      github: vi.fn(),
      deployKey: vi.fn(),
    });
    expect(d).toEqual({ ok: false, reason: 'no key' });
  });
});
