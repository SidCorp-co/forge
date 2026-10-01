import { describe, expect, it, vi } from 'vitest';

const rows = [
  { projectId: 'p-1', runnerId: 'r-1', slug: 'app' },
  { projectId: 'p-1', runnerId: 'r-2', slug: 'app' },
  { projectId: 'p-2', runnerId: 'r-3', slug: 'bare' },
];
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => rows }) }) }) },
}));
const declared = vi.fn(async (projectId: string) => ({
  repository: null,
  defaultBranch: projectId === 'p-1' ? 'dev' : null,
  setup: projectId === 'p-1' ? 'pnpm install' : null,
}));
vi.mock('../project-config/source.js', () => ({ readDeclaredSource: declared }));

const { listDeviceAssignments } = await import('./me-runners.js');

describe('listDeviceAssignments', () => {
  it("answers each runner's workspaceSetup and baseBranch from its project document, read once per project", async () => {
    const out = await listDeviceAssignments('d-1');
    expect(out.map((r) => [r.runnerId, r.workspaceSetup, r.baseBranch])).toEqual([
      ['r-1', 'pnpm install', 'dev'],
      ['r-2', 'pnpm install', 'dev'],
      ['r-3', null, null],
    ]);
    expect(declared.mock.calls.map(([id]) => id)).toEqual(['p-1', 'p-2']);
  });
});
