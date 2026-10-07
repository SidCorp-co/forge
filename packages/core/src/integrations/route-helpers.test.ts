import { describe, expect, it } from 'vitest';
import { registerAllIntegrations } from '../integration-registry.js';
import { summarizeConnectionWithUsage } from './route-helpers.js';
import type { IntegrationBindingRow, IntegrationConnectionRow } from './store.js';

registerAllIntegrations();

const connection = {
  id: 'c1',
  ownerType: 'org',
  ownerId: 'o1',
  provider: 'coolify',
  displayName: 'Coolify (manage.example.com)',
  config: { baseUrl: 'https://manage.example.com' },
  active: true,
  lastHealthStatus: 'ok',
  lastHealthDetail: null,
  lastHealthAt: new Date('2026-10-07T00:00:00Z'),
  breakerOpenedAt: null,
  secretsEnc: Buffer.from('x'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as IntegrationConnectionRow;

function binding(id: string, resourceUuid: string, projectId = 'p1') {
  return {
    id,
    projectId,
    connectionId: 'c1',
    provider: 'coolify',
    role: 'deploy',
    label: '',
    active: true,
    config: { targets: [{ id: 'primary', label: 'primary', resourceUuid }] },
  } as unknown as IntegrationBindingRow;
}

describe('the connections directory row: what a person reads off one credential', () => {
  it('carries the connection health bucketed by core, so the row status pill has a state to name', () => {
    const row = summarizeConnectionWithUsage(connection, [], () => null) as {
      directoryStatus?: string;
    };
    expect(row.directoryStatus).toBe('connected');
  });

  it('names two deploy bindings on one project apart: the environment, else the application', () => {
    const row = summarizeConnectionWithUsage(
      connection,
      [binding('b-dev', 'e0o0c40k'), binding('b-other', 'y8w4c4ks')],
      (b) => (b.id === 'b-dev' ? 'dev' : null),
    );
    expect(row.usage.bindings.map((b) => (b as { name?: string }).name)).toEqual([
      'dev',
      'app y8w4c4ks',
    ]);
  });

  it('names bindings on different projects by role alone, since the project already tells them apart', () => {
    const row = summarizeConnectionWithUsage(
      connection,
      [binding('b1', 'e0o0c40k', 'p1'), binding('b2', 'y8w4c4ks', 'p2')],
      () => null,
    );
    expect(row.usage.bindings.map((b) => (b as { name?: string }).name)).toEqual([
      'Deploy',
      'Deploy',
    ]);
  });
});
