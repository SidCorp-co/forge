// Ownership is proved against GitHub, not inferred from the caller having one
// candidate. The difference only shows once a second project connects, which is
// exactly when writing the wrong installation id is unrecoverable by hand.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listConnections = vi.fn();
const listBindings = vi.fn();
const projectRole = vi.fn();

// The caller's right to record an installation is per project, and is the same question
// `assertAdmin(assertProjectMember(...))` asks in the route, so it is answered by the one function
// both read.
vi.mock('../../lib/authz.js', () => ({
  effectiveProjectRole: (...a: unknown[]) => projectRole(...a),
}));

vi.mock('../store.js', () => ({
  listBindingsForConnection: (...a: unknown[]) => listBindings(...a),
  decryptConnectionSecrets: (c: { secrets?: Record<string, string> }) => c.secrets ?? {},
}));

// Which Apps the caller may be completing an install for is its own subject
// (install-candidates.ts, proved against real Postgres in the e2e); what is
// asserted here is what this resolver does with the set it is handed.
vi.mock('./install-candidates.js', () => ({
  listGithubAppsReachableBy: (...a: unknown[]) => listConnections(...a),
}));

vi.mock('./app-auth.js', () => ({ buildAppJwt: (appId: string) => `jwt-for-${appId}` }));

import { findBindingOwningInstallation, installNotCompletable } from './install-resolve.js';

function connection(id: string, secrets: Record<string, string> | null) {
  return { id, provider: 'github', secrets };
}

function bindingFor(id: string) {
  return {
    binding: { id: `bind-${id}`, provider: 'github', projectId: `proj-${id}` },
    connection: {},
  };
}

describe('findBindingOwningInstallation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unless a test says otherwise the caller administers every project, which is what these
    // tests were written under.
    projectRole.mockResolvedValue({ role: 'admin' });
  });

  it('returns the binding of the App whose JWT GitHub accepts, not the first candidate', async () => {
    listConnections.mockResolvedValue([
      connection('a', { appId: '1', privateKey: 'k1' }),
      connection('b', { appId: '2', privateKey: 'k2' }),
    ]);
    listBindings.mockImplementation(async (id: string) => [bindingFor(id)]);

    const fetchImpl = vi.fn(async (_u: string, init: { headers: Record<string, string> }) => ({
      ok: init.headers.authorization === 'Bearer jwt-for-2',
    })) as unknown as typeof fetch;

    const found = await findBindingOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl,
    });

    expect(found?.binding.id).toBe('bind-b');
    expect(listBindings).toHaveBeenCalledTimes(1);
  });

  it('returns null when no App of the caller owns it, rather than adopting one', async () => {
    listConnections.mockResolvedValue([connection('a', { appId: '1', privateKey: 'k1' })]);
    listBindings.mockResolvedValue([bindingFor('a')]);
    const fetchImpl = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    expect(
      await findBindingOwningInstallation({ userId: 'u1', installationId: 42, fetchImpl }),
    ).toBeNull();
    expect(listBindings).not.toHaveBeenCalled();
  });

  it('keeps looking when one App is unreachable', async () => {
    listConnections.mockResolvedValue([
      connection('a', { appId: '1', privateKey: 'k1' }),
      connection('b', { appId: '2', privateKey: 'k2' }),
    ]);
    listBindings.mockImplementation(async (id: string) => [bindingFor(id)]);

    const fetchImpl = vi.fn(async (_u: string, init: { headers: Record<string, string> }) => {
      if (init.headers.authorization === 'Bearer jwt-for-1') throw new Error('network');
      return { ok: true };
    }) as unknown as typeof fetch;

    const found = await findBindingOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl,
    });
    expect(found?.binding.id).toBe('bind-b');
  });

  it('skips a connection whose secrets never converted', async () => {
    listConnections.mockResolvedValue([connection('a', null)]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(
      await findBindingOwningInstallation({ userId: 'u1', installationId: 42, fetchImpl }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('an App bound to more than one project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listConnections.mockResolvedValue([connection('a', { appId: '1', privateKey: 'k1' })]);
    listBindings.mockResolvedValue([bindingFor('first'), bindingFor('second')]);
  });
  const accepted = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
  const administers = (projectId: string) => (_user: string, project: string) =>
    Promise.resolve({ role: project === projectId ? 'admin' : 'member' });

  it('resolves it through the binding the caller administers, not the newest one', async () => {
    projectRole.mockImplementation(administers('proj-second'));

    const found = await findBindingOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl: accepted,
    });

    expect(found?.binding.id).toBe('bind-second');
  });

  it('refuses by name where the caller administers none of its projects, instead of a bare forbidden', async () => {
    projectRole.mockResolvedValue({ role: 'member' });

    const refusal = await findBindingOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl: accepted,
    }).catch((err: unknown) => err);

    expect(refusal).toMatchObject({
      status: 403,
      cause: { code: 'INSTALL_NOT_COMPLETABLE' },
    });
    expect((refusal as Error).message).toMatch(/connection a\b/);
    expect((refusal as Error).message).toMatch(/admin of a project it is bound to/);
  });

  it('names the App by its display name when it has one', () => {
    expect(installNotCompletable({ id: 'c1', displayName: 'GitHub App forge' }).message).toContain(
      '"GitHub App forge"',
    );
  });

  it('does not stand a refusal in for an App GitHub does not say owns the installation', async () => {
    projectRole.mockResolvedValue({ role: 'member' });
    const refused = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    expect(
      await findBindingOwningInstallation({ userId: 'u1', installationId: 42, fetchImpl: refused }),
    ).toBeNull();
  });
});
