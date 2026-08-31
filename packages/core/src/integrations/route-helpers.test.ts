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
