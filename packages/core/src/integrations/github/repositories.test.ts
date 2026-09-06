// The picker is only as honest as this list. A repository it offers that the
// App cannot reach fails at the first webhook rather than at the dropdown, and
// an installation dropped in silence reads as "no repositories" rather than
// "one account went away".

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./app-auth.js', () => ({
  buildAppJwt: () => 'app-jwt',
  installationToken: async (a: { installationId: number }) => {
    if (a.installationId === 999) throw new Error('revoked');
    return `tok-${a.installationId}`;
  },
}));

import { listInstallationRepositories } from './repositories.js';

function repo(owner: string, name: string) {
  return { name, full_name: `${owner}/${name}`, owner: { login: owner } };
}

function fetchStub(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return { ok: false, json: async () => ({}) };
    const value = routes[key];
    const body =
      typeof value === 'function'
        ? (value as (h: string) => unknown)(init.headers.authorization ?? '')
        : value;
    if (body === null) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
}

const ARGS = { appId: '1', privateKey: 'k' };

describe('listInstallationRepositories', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tags every repository with the installation that reaches it', async () => {
    const fetchImpl = fetchStub({
      '/app/installations': [
        { id: 111, account: { login: 'SidCorp-co' } },
        { id: 222, account: { login: 'other-org' } },
      ],
      '/installation/repositories': (auth: string) =>
        auth === 'Bearer tok-111'
          ? { repositories: [repo('SidCorp-co', 'forge')] }
          : { repositories: [repo('other-org', 'codemap')] },
    });

    const { repositories, truncated } = await listInstallationRepositories({ ...ARGS, fetchImpl });

    expect(truncated).toBe(false);
    expect(repositories).toEqual([
      {
        installationId: 111,
        account: 'SidCorp-co',
        owner: 'SidCorp-co',
        repo: 'forge',
        fullName: 'SidCorp-co/forge',
      },
      {
        installationId: 222,
        account: 'other-org',
        owner: 'other-org',
        repo: 'codemap',
        fullName: 'other-org/codemap',
      },
    ]);
  });

  it('keeps the installations it can still mint for when one is revoked', async () => {
    const fetchImpl = fetchStub({
      '/app/installations': [{ id: 999 }, { id: 222, account: { login: 'other-org' } }],
      '/installation/repositories': { repositories: [repo('other-org', 'codemap')] },
    });

    const { repositories } = await listInstallationRepositories({ ...ARGS, fetchImpl });
    expect(repositories.map((r) => r.installationId)).toEqual([222]);
  });

  it('reports truncation instead of quietly cutting the list', async () => {
    const page = { repositories: Array.from({ length: 100 }, (_, i) => repo('o', `r${i}`)) };
    const fetchImpl = fetchStub({
      '/app/installations': [{ id: 111, account: { login: 'o' } }],
      '/installation/repositories': page,
    });

    const { repositories, truncated } = await listInstallationRepositories({ ...ARGS, fetchImpl });
    expect(truncated).toBe(true);
    expect(repositories).toHaveLength(500);
  });

  it('returns nothing when the App has no installations at all', async () => {
    const fetchImpl = fetchStub({ '/app/installations': [] });
    expect(await listInstallationRepositories({ ...ARGS, fetchImpl })).toEqual({
      repositories: [],
      truncated: false,
    });
  });

  it('skips a repository GitHub returned without an owner rather than inventing one', async () => {
    const fetchImpl = fetchStub({
      '/app/installations': [{ id: 111, account: { login: 'o' } }],
      '/installation/repositories': { repositories: [{ name: 'orphan' }, repo('o', 'good')] },
    });

    const { repositories } = await listInstallationRepositories({ ...ARGS, fetchImpl });
    expect(repositories.map((r) => r.fullName)).toEqual(['o/good']);
  });
});
