// Ownership is proved against GitHub, not inferred from the caller having one
// candidate. The difference only shows once a second project connects, which is
// exactly when writing the wrong installation id is unrecoverable by hand.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listConnections = vi.fn();
const listBindings = vi.fn();

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

import { findConnectionOwningInstallation } from './install-resolve.js';

function connection(id: string, secrets: Record<string, string> | null) {
  return { id, provider: 'github', secrets };
}

function bindingFor(id: string) {
  return {
    binding: { id: `bind-${id}`, provider: 'github', projectId: `proj-${id}` },
    connection: {},
  };
}

describe('findConnectionOwningInstallation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the App whose JWT GitHub accepts, not the first candidate, with the project its binding names', async () => {
    listConnections.mockResolvedValue([
      connection('a', { appId: '1', privateKey: 'k1' }),
      connection('b', { appId: '2', privateKey: 'k2' }),
    ]);
    listBindings.mockImplementation(async (id: string) => [bindingFor(id)]);

    const fetchImpl = vi.fn(async (_u: string, init: { headers: Record<string, string> }) => ({
      ok: init.headers.authorization === 'Bearer jwt-for-2',
    })) as unknown as typeof fetch;

    const found = await findConnectionOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl,
    });

    expect(found?.connection.id).toBe('b');
    expect(found?.projectId).toBe('proj-b');
    expect(listBindings).toHaveBeenCalledTimes(1);
  });

  it('returns null when no App of the caller owns it, rather than adopting one', async () => {
    listConnections.mockResolvedValue([connection('a', { appId: '1', privateKey: 'k1' })]);
    listBindings.mockResolvedValue([bindingFor('a')]);
    const fetchImpl = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;

    expect(
      await findConnectionOwningInstallation({ userId: 'u1', installationId: 42, fetchImpl }),
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

    const found = await findConnectionOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl,
    });
    expect(found?.connection.id).toBe('b');
  });

  it('answers the App with no project when no binding names it yet', async () => {
    listConnections.mockResolvedValue([connection('a', { appId: '1', privateKey: 'k1' })]);
    listBindings.mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    const found = await findConnectionOwningInstallation({
      userId: 'u1',
      installationId: 42,
      fetchImpl,
    });
    expect(found).toMatchObject({ connection: { id: 'a' }, projectId: null });
  });

  it('skips a connection whose secrets never converted', async () => {
    listConnections.mockResolvedValue([connection('a', null)]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(
      await findConnectionOwningInstallation({ userId: 'u1', installationId: 42, fetchImpl }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
