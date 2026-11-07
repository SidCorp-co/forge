import { describe, expect, it } from 'vitest';
import { registerAllIntegrations } from '../integration-registry.js';
import { projectNameLookup, summarizeConnectionWithUsage } from './route-helpers.js';
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

const NAMES = (projectId: string) =>
  ({ p1: 'Hop Clinic', p2: 'Forge Getforge Beta' })[projectId] ?? '';

describe('the connections directory row: what a person reads off one credential', () => {
  // ISS-1072: the directory drew a binding's project by its id where the viewer's own project list
  // did not hold it; core names it, so no row reads a UUID
  it('names the project each binding is on, by name', () => {
    const row = summarizeConnectionWithUsage(
      connection,
      [binding('b1', 'e0o0c40k', 'p1'), binding('b2', 'y8w4c4ks', 'p2')],
      () => null,
      NAMES,
    );
    expect(row.usage.bindings.map((b) => (b as { projectName?: string }).projectName)).toEqual([
      'Hop Clinic',
      'Forge Getforge Beta',
    ]);
  });

  it('carries the connection health bucketed by core, so the row status pill has a state to name', () => {
    const row = summarizeConnectionWithUsage(connection, [], () => null, NAMES) as {
      directoryStatus?: string;
    };
    expect(row.directoryStatus).toBe('connected');
  });

  it('names two deploy bindings on one project apart: the environment, else the application', () => {
    const row = summarizeConnectionWithUsage(
      connection,
      [binding('b-dev', 'e0o0c40k'), binding('b-other', 'y8w4c4ks')],
      (b) => (b.id === 'b-dev' ? 'dev' : null),
      NAMES,
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
      NAMES,
    );
    expect(row.usage.bindings.map((b) => (b as { name?: string }).name)).toEqual([
      'Deploy',
      'Deploy',
    ]);
  });
});

// a binding is drawn by its project's name on the directory and on a connection's drawer alike
// (ISS-1072); a binding whose project no row names is a broken row, refused by name, never drawn as an id
describe('the project name a binding is drawn by', () => {
  const nameOf = projectNameLookup([{ id: 'p1', name: 'Hop Clinic' }]);

  it("reads the project row's name", () => {
    expect(nameOf('p1')).toBe('Hop Clinic');
  });

  it('refuses a project no row names, naming its id', () => {
    expect(() => nameOf('p9')).toThrow(
      'integration binding names project p9, which no project row holds',
    );
  });
});
