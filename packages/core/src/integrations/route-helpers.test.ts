import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../ws/server.js', () => ({ roomManager: { broadcast: vi.fn() } }));

const { summarizeBinding } = await import('./route-helpers.js');

function pair(bindingActive: boolean, connectionActive: boolean) {
  return {
    binding: {
      id: 'bind-1',
      connectionId: 'conn-1',
      projectId: 'proj-1',
      provider: 'rocketchat',
      environment: 'prod',
      config: { rids: ['room-1'] },
      integrationSecret: null,
      active: bindingActive,
      label: '',
      instructions: null,
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    },
    connection: {
      id: 'conn-1',
      ownerType: 'org',
      ownerId: 'org-1',
      provider: 'rocketchat',
      displayName: null,
      config: { serverUrl: 'https://chat.example.com' },
      secretsEnc: Buffer.from('enc'),
      oauthInstallationId: null,
      active: connectionActive,
      lastHealthStatus: 'ok',
      lastHealthAt: new Date('2026-08-31T00:00:00.000Z'),
      breakerOpenedAt: null,
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      updatedAt: new Date('2026-08-31T00:00:00.000Z'),
    },
  } as unknown as Parameters<typeof summarizeBinding>[0];
}

describe('summarizeBinding — the two active tiers', () => {
  it('names the credential tier when the project opted in and the credential is disabled', () => {
    const s = summarizeBinding(pair(true, false));
    expect(s.active).toBe(false);
    expect(s.bindingActive).toBe(true);
    expect(s.connectionActive).toBe(false);
  });

  it('names the binding tier when the project opted out and the credential is live', () => {
    const s = summarizeBinding(pair(false, true));
    expect(s.active).toBe(false);
    expect(s.bindingActive).toBe(false);
    expect(s.connectionActive).toBe(true);
  });

  it('reports active only when both tiers are on', () => {
    const s = summarizeBinding(pair(true, true));
    expect(s.active).toBe(true);
    expect(s.bindingActive).toBe(true);
    expect(s.connectionActive).toBe(true);
  });

  it('leaks no credential bytes into the summary', () => {
    expect(JSON.stringify(summarizeBinding(pair(true, true)))).not.toContain('enc');
  });
});

const { defaultConnectionDisplayName, summarizeConnectionWithUsage } = await import(
  './route-helpers.js'
);

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    ownerType: 'user',
    ownerId: 'user-1',
    provider: 'coolify',
    displayName: null,
    config: {},
    secretsEnc: Buffer.from('x'),
    active: true,
    lastHealthStatus: 'ok',
    lastHealthAt: null,
    breakerOpenedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as never;
}

function bindingRow(id: string, projectId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    connectionId: 'conn-1',
    projectId,
    provider: 'coolify',
    environment: 'prod',
    config: {},
    integrationSecret: null,
    label: '',
    active: true,
    instructions: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as never;
}

describe('summarizeConnectionWithUsage', () => {
  it('names every project the credential is bound to, so two cards can differ', () => {
    const out = summarizeConnectionWithUsage(connectionRow(), [
      bindingRow('b1', 'proj-a'),
      bindingRow('b2', 'proj-b', { environment: 'staging', active: false }),
    ]);
    expect(out.usage.bindings).toEqual([
      { id: 'b1', projectId: 'proj-a', environment: 'prod', label: '', active: true },
      { id: 'b2', projectId: 'proj-b', environment: 'staging', label: '', active: false },
    ]);
  });

  it('reports an unused connection as unused rather than omitting usage', () => {
    expect(summarizeConnectionWithUsage(connectionRow(), []).usage).toEqual({ bindings: [] });
  });

  it('still never echoes the encrypted credential', () => {
    const out = summarizeConnectionWithUsage(connectionRow(), []);
    expect(out.hasSecrets).toBe(true);
    expect(Object.keys(out)).not.toContain('secretsEnc');
  });
});

describe('defaultConnectionDisplayName', () => {
  it('names a connection by the host its config points at', () => {
    expect(
      defaultConnectionDisplayName('coolify', { baseUrl: 'https://deploy.example.com/api' }),
    ).toBe('coolify · deploy.example.com');
  });

  it('falls back through the identifying keys a provider actually stores', () => {
    expect(defaultConnectionDisplayName('postman', { workspaceName: 'Forge API' })).toBe(
      'postman · Forge API',
    );
    expect(defaultConnectionDisplayName('epodsystem', { storeSlug: 'hp-home' })).toBe(
      'epodsystem · hp-home',
    );
  });

  it('returns null rather than inventing a detail the config does not carry', () => {
    expect(defaultConnectionDisplayName('sentry', {})).toBeNull();
    expect(defaultConnectionDisplayName('coolify', { baseUrl: 'not a url' })).toBeNull();
  });
});
