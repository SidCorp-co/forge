import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

import { GitHubClientError } from '../integrations/github/client.js';
import { SourceHostUnavailable } from '../integrations/source-host/errors.js';
import type { SourceHost } from '../integrations/source-host/types.js';
import { encryptSecret } from '../integrations/vault.js';
import {
  type DeployKeyRow,
  type LiveSourceDeps,
  readProjectDivergence,
  resolveLiveSource,
} from './live-source.js';

const readDivergence = vi.fn();
const host = { fullName: 'SidCorp-co/forge', readDivergence } as unknown as SourceHost;
const GITLAB = 'gitlab.com/thanhnguyen21/sid-desk';
const GITLAB_SSH = 'git@gitlab.com:thanhnguyen21/sid-desk.git';
let keyEnc: Buffer;

beforeAll(() => {
  keyEnc = encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nsid-desk\n');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function noBinding(): Promise<SourceHost> {
  throw new SourceHostUnavailable('no_binding', 'this project has no active source host binding');
}

function deps(over: Partial<LiveSourceDeps> & { row?: DeployKeyRow }): LiveSourceDeps {
  return {
    sourceHost: over.sourceHost ?? (async () => noBinding()),
    deployKey:
      over.deployKey ?? (async () => over.row ?? { repository: GITLAB, privateKeyEnc: keyEnc }),
  };
}

describe('resolveLiveSource', () => {
  it('reads through the source host where the project has an active binding', async () => {
    const deployKey = vi.fn();
    const s = await resolveLiveSource('p', deps({ sourceHost: async () => host, deployKey }));
    expect(s).toEqual({ kind: 'binding', host });
    expect(deployKey).not.toHaveBeenCalled();
  });

  it('refuses in GitHub’s words a binding that exists and cannot be used, without the deploy key', async () => {
    const deployKey = vi.fn();
    const s = await resolveLiveSource(
      'p',
      deps({
        sourceHost: async () => {
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

  it('refuses a binding on another host than the declared repository in its own words, without the deploy key', async () => {
    const deployKey = vi.fn();
    const s = await resolveLiveSource(
      'p',
      deps({
        sourceHost: async () => {
          throw new SourceHostUnavailable(
            'host_mismatch',
            'the project document declares a repository on gitlab.com',
          );
        },
        deployKey,
      }),
    );
    expect(s).toEqual({
      kind: 'refused',
      reason: 'the project document declares a repository on gitlab.com',
    });
    expect(deployKey).not.toHaveBeenCalled();
  });

  it('tells a GitLab-hosted project with no key where to attach one, or to bind its own host', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({ row: { repository: GITLAB, privateKeyEnc: null } }),
    );
    expect(s.kind).toBe('refused');
    const reason = s.kind === 'refused' ? s.reason : '';
    expect(reason).toBe(
      "Forge holds no source host binding and no deploy key for this project's repository on gitlab.com, so it cannot read the branches — attach a deploy key under the project's Settings → Runners → Git access, or bind the repository's host on its Integrations page",
    );
    expect(reason).not.toMatch(/GitHub/);
  });

  it('offers a GitHub-hosted project with neither the binding as well as the key', async () => {
    const s = await resolveLiveSource(
      'p',
      deps({ row: { repository: 'github.com/SidCorp-co/forge', privateKeyEnc: null } }),
    );
    expect(s.kind === 'refused' && s.reason).toMatch(
      /on github\.com, .*Git access, or bind the repository's host on its Integrations page$/,
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
    readDivergence.mockReset();
    readDivergence.mockResolvedValue(measured);
    const deployKey = vi.fn(async () => ({ ...measured, baseSha: 'from-git' }));
    const key = { kind: 'deploy_key' as const, repoUrl: GITLAB_SSH, privateKey: 'k' };
    const viaGit = await readProjectDivergence('p', refs, { source: async () => key, deployKey });
    expect(viaGit).toMatchObject({ ok: true, baseSha: 'from-git' });
    expect(deployKey).toHaveBeenCalledWith(key, refs);
    expect(readDivergence).not.toHaveBeenCalled();

    const viaHost = await readProjectDivergence('p', refs, {
      source: async () => ({ kind: 'binding', host }),
      deployKey,
    });
    expect(viaHost).toBe(measured);
    expect(readDivergence).toHaveBeenCalledWith(refs);
  });

  it('answers a refused source as a refusal carrying its reason', async () => {
    const d = await readProjectDivergence('p', refs, {
      source: async () => ({ kind: 'refused', reason: 'no key' }),
      deployKey: vi.fn(),
    });
    expect(d).toEqual({ ok: false, reason: 'no key' });
  });
});
