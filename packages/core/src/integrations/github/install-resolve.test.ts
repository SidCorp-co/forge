// Ownership is proved against GitHub, not inferred from the caller having one
// candidate. The difference only shows once a second project connects, which is
// exactly when writing the wrong installation id is unrecoverable by hand.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listConnections = vi.fn();
const listBindings = vi.fn();

vi.mock('../store.js', () => ({
  listConnectionsForPrincipalUser: (...a: unknown[]) => listConnections(...a),
  listBindingsForConnection: (...a: unknown[]) => listBindings(...a),
  decryptConnectionSecrets: (c: { secrets?: Record<string, string> }) => c.secrets ?? {},
}));

vi.mock('./app-auth.js', () => ({ buildAppJwt: (appId: string) => `jwt-for-${appId}` }));

import { findBindingOwningInstallation } from './install-resolve.js';

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
  beforeEach(() => vi.clearAllMocks());

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
