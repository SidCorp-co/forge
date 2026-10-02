import { describe, expect, it, vi } from 'vitest';

const rows = [
  { projectId: 'p-1', runnerId: 'r-1', slug: 'app' },
  { projectId: 'p-2', runnerId: 'r-3', slug: 'bare' },
];
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => rows }) }) }) },
}));
const folded = vi.fn(async (given: typeof rows) =>
  given.map((r) => ({ ...r, baseBranch: 'dev', workspaceSetup: 'pnpm install' })),
);
vi.mock('../project-config/source.js', () => ({ withDeclaredSource: folded }));
const credentialed = vi.fn(async (_ids: string[]) => new Set(['p-1']));
vi.mock('../git/host-credential.js', () => ({ projectsWithHostCredential: credentialed }));

const { listDeviceAssignments } = await import('./me-runners.js');

describe('listDeviceAssignments', () => {
  it('hands its rows to withDeclaredSource and answers what that one loop read', async () => {
    const out = await listDeviceAssignments('d-1');
    expect(folded).toHaveBeenCalledWith(rows);
    expect(out.map((r) => [r.runnerId, r.workspaceSetup, r.baseBranch])).toEqual([
      ['r-1', 'pnpm install', 'dev'],
      ['r-3', 'pnpm install', 'dev'],
    ]);
  });

  it('says per project whether core mints a host credential, so bind --path installs the helper', async () => {
    const out = await listDeviceAssignments('d-1');
    expect(credentialed).toHaveBeenCalledWith(['p-1', 'p-2']);
    expect(out.map((r) => [r.projectId, r.hostCredential])).toEqual([
      ['p-1', true],
      ['p-2', false],
    ]);
  });
});
