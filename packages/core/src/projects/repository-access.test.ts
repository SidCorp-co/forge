import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import type { PinnedSshHost } from '../git/ssh-host-guard.js';
import type { GitHubRepoClient } from '../integrations/github/client.js';
import type { LiveSource } from './live-source.js';
import { type RepositoryAccessDeps, readableThrough, withRepository } from './repository-access.js';
import type { RepositoryAccess } from './repository-reader.js';

const client = { fullName: 'SidCorp-co/forge' } as unknown as GitHubRepoClient;
const GITLAB = 'git@gitlab.com:sid/desk.git';
const pin: PinnedSshHost = { host: 'gitlab.com', address: '172.65.251.78' };

type Opened = (env: NodeJS.ProcessEnv, dir: string, p: PinnedSshHost) => Promise<unknown>;

/** A deploy-key opener that hands the reading an empty environment, as the real one would its key. */
const opens = vi.fn(async (_key: string, _url: string, fn: Opened) => fn({}, '/nowhere', pin));

const keyed = (deployKey: unknown): Partial<RepositoryAccessDeps> => ({
  source: async () => ({ kind: 'deploy_key', repoUrl: GITLAB, privateKey: 'k' }),
  deployKey: deployKey as RepositoryAccessDeps['deployKey'],
});

const seen = (into: RepositoryAccess[]) => async (access: RepositoryAccess) => {
  into.push(access);
  return access.kind;
};

describe('withRepository', () => {
  it('reads through the GitHub binding where the project has one, never opening the key', async () => {
    const deployKey = vi.fn();
    const got: RepositoryAccess[] = [];
    await withRepository('p', seen(got), {
      source: async () => ({ kind: 'binding', client }),
      deployKey,
    });
    expect(got[0]).toMatchObject({
      kind: 'reader',
      reader: { name: 'SidCorp-co/forge', route: 'binding' },
    });
    expect(deployKey).not.toHaveBeenCalled();
  });

  it('reads with git, as the deploy key, where the project has only a key', async () => {
    const got: RepositoryAccess[] = [];
    await withRepository('p', seen(got), keyed(opens));
    expect(opens).toHaveBeenCalledWith('k', GITLAB, expect.any(Function));
    expect(got[0]).toMatchObject({
      kind: 'reader',
      reader: { name: GITLAB, route: 'deploy_key' },
    });
  });

  it('hands a refused source on with its reason, whether anything was declared, and its route', async () => {
    const got: RepositoryAccess[] = [];
    const refused: LiveSource = {
      kind: 'refused',
      reason: 'no deploy key — attach a deploy key',
      cause: 'no deploy key',
      clears: 'attach a deploy key',
      unbound: true,
      route: 'deploy_key',
    };
    await withRepository('p', seen(got), { source: async () => refused, deployKey: vi.fn() });
    expect(got).toEqual([
      {
        kind: 'refused',
        cause: 'no deploy key',
        clears: 'attach a deploy key',
        unbound: true,
        route: 'deploy_key',
      },
    ]);
  });

  it('answers a remote the host guard refuses as refused, on the key route, not unbound', async () => {
    const got: RepositoryAccess[] = [];
    const guarded = async () => {
      throw new HTTPException(400, { message: 'that host resolves to a private address' });
    };
    await withRepository('p', seen(got), keyed(guarded));
    expect(got).toEqual([
      {
        kind: 'refused',
        cause: `${GITLAB} cannot be read: that host resolves to a private address`,
        unbound: false,
        route: 'deploy_key',
      },
    ]);
  });

  it("lets the caller's own throw out, rather than answering it as a refused remote", async () => {
    const run = withRepository(
      'p',
      async () => {
        throw new HTTPException(409, { message: 'the caller refused' });
      },
      keyed(opens),
    );
    await expect(run).rejects.toThrow('the caller refused');
  });
});

describe('readableThrough', () => {
  it('names the route that clears a read, and only a GitHub route names GitHub', () => {
    expect(readableThrough('binding')).toContain('through a GitHub binding');
    expect(readableThrough('deploy_key')).toContain(
      "with the deploy key attached under the project's Settings → Runners → Git access",
    );
    expect(readableThrough('deploy_key')).not.toMatch(/GitHub|Integrations/);
  });
});
