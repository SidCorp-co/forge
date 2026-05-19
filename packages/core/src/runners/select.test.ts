import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { execute },
}));

vi.mock('../lib/dispatch-liveness.js', () => ({
  dispatchLivenessMs: () => 120_000,
}));

const { selectRunnerForJob } = await import('./select.js');

beforeEach(() => {
  execute.mockReset();
});

describe('selectRunnerForJob', () => {
  const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const DEVICE_X = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  // ISS-172 Slice A — once a device can be a runner for N projects, the
  // dispatcher must thread `projectId` through to the SQL filter so it never
  // picks project B's runner row when serving a project A job (even though
  // both rows share the same `device_id`).
  it('returns the per-project runner row when the same device is bound to two projects', async () => {
    const rowA = {
      id: 'r-a',
      project_id: PROJECT_A,
      type: 'claude-code',
      host: 'device',
      device_id: DEVICE_X,
      name: 'laptop',
      labels: [],
      capabilities: {},
      config: {},
      status: 'online',
      last_seen_at: new Date().toISOString(),
      last_error: null,
    };
    const rowB = { ...rowA, id: 'r-b', project_id: PROJECT_B };

    execute.mockImplementationOnce(async (q: unknown) => {
      const str = JSON.stringify(q);
      // Drizzle's sql template stringifies params separately; assert the
      // projectId we asked for is the one bound, then return the matching row.
      if (str.includes(PROJECT_A)) return [rowA];
      if (str.includes(PROJECT_B)) return [rowB];
      return [];
    });
    const a = await selectRunnerForJob({ projectId: PROJECT_A });
    expect(a?.id).toBe('r-a');
    expect(a?.projectId).toBe(PROJECT_A);

    execute.mockImplementationOnce(async (q: unknown) => {
      const str = JSON.stringify(q);
      if (str.includes(PROJECT_A)) return [rowA];
      if (str.includes(PROJECT_B)) return [rowB];
      return [];
    });
    const b = await selectRunnerForJob({ projectId: PROJECT_B });
    expect(b?.id).toBe('r-b');
    expect(b?.projectId).toBe(PROJECT_B);
  });

  it('returns null when no online runner matches', async () => {
    execute.mockResolvedValueOnce([]);
    const r = await selectRunnerForJob({ projectId: PROJECT_A });
    expect(r).toBeNull();
  });
});
