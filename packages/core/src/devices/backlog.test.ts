// `db.execute` is mocked (no Postgres), so ranking and the JOINs themselves are
// the database's business. What these tests own is `backlog.ts`'s own logic:
// which projects contribute an admission at all, what the SQL is asked to
// exclude, and the shape a master is handed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();

vi.mock('../db/client.js', () => ({ db: { execute } }));

const { readBacklog, readBacklogAdmissions } = await import('./backlog.js');

const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const projectRow = (pipelineConfig: unknown) => ({
  id: PROJECT,
  agent_config: { pipelineConfig },
});

const issueRow = (over: Record<string, unknown> = {}) => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  iss_seq: 917,
  project_id: PROJECT,
  title: 'a draft nobody has decided about',
  description: null,
  priority: 'high',
  category: 'kernel-hardening',
  status: 'draft',
  age_minutes: 12,
  relations: [],
  ...over,
});

beforeEach(() => {
  execute.mockReset();
});

describe('readBacklogAdmissions', () => {
  // cm:guard AC1 — a project that never declared a backlog must contribute NOTHING, which is every project on the fleet on the day this shipped.
  it('ignores a project with no poolBacklog', async () => {
    execute.mockResolvedValueOnce([projectRow({ enabled: true })]);
    await expect(readBacklogAdmissions({ deviceId: DEVICE })).resolves.toEqual([]);
  });

  it('ignores a project whose poolBacklog admits nothing', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: [] } })]);
    await expect(readBacklogAdmissions({ deviceId: DEVICE })).resolves.toEqual([]);
  });

  it('ignores a project with no agent_config at all', async () => {
    execute.mockResolvedValueOnce([{ id: PROJECT, agent_config: null }]);
    await expect(readBacklogAdmissions({ deviceId: DEVICE })).resolves.toEqual([]);
  });

  it('reads the declared statuses and the declared limit', async () => {
    execute.mockResolvedValueOnce([
      projectRow({ poolBacklog: { statuses: ['draft', 'on_hold'], limit: 7 } }),
    ]);
    await expect(readBacklogAdmissions({ deviceId: DEVICE })).resolves.toEqual([
      { projectId: PROJECT, statuses: ['draft', 'on_hold'], limit: 7 },
    ]);
  });

  it('defaults the limit when the project declared none', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    const [a] = await readBacklogAdmissions({ deviceId: DEVICE });
    expect(a?.limit).toBe(20);
  });

  // cm:guard the SAFE direction. A stored config this build can no longer parse must read as NO backlog: a hand-read would keep offering rows `promoteFromBacklog` then refuses, and the master could not tell which of the two surfaces was wrong.
  it('reads a config the canonical schema rejects as no backlog at all', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['open'] } })]);
    await expect(readBacklogAdmissions({ deviceId: DEVICE })).resolves.toEqual([]);
  });

  // cm:guard the device principal must see only what its own bindings cover. Scoped through `runners` exactly as `readPool` is; a query that dropped the join would hand a paired box its owner's whole account.
  it('scopes the project read through this device runners binding', async () => {
    execute.mockResolvedValueOnce([]);
    await readBacklogAdmissions({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain('runners');
    expect(q).toContain(DEVICE);
  });

  it('narrows to one project when the caller named one', async () => {
    execute.mockResolvedValueOnce([]);
    await readBacklogAdmissions({ deviceId: DEVICE, projectId: PROJECT });
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain(PROJECT);
  });
});

describe('readBacklog', () => {
  it('asks the database nothing when no project admits a status', async () => {
    execute.mockResolvedValueOnce([projectRow({ enabled: true })]);
    await expect(readBacklog({ deviceId: DEVICE })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  // cm:guard AC4 — no `jobId` on a backlog row, ever. A row a master could hand to `pool claim` is a malformed claim waiting to happen, and keeping the field off the type is the whole reason the backlog is a sibling key.
  it('returns rows carrying no job id', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    execute.mockResolvedValueOnce([issueRow()]);
    const [row] = await readBacklog({ deviceId: DEVICE });
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('jobId');
    expect(row?.issueKey).toBe('ISS-917');
    expect(row?.status).toBe('draft');
  });

  it('carries the raw blocker facts and never a computed verdict', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    execute.mockResolvedValueOnce([
      issueRow({
        relations: [
          {
            kind: 'blocks',
            dependsOnKey: 'ISS-900',
            blockerStatus: 'closed',
            blockerMergedAt: null,
            edgeValidUntil: null,
          },
        ],
      }),
    ]);
    const [row] = await readBacklog({ deviceId: DEVICE });
    expect(row?.relations).toEqual([
      {
        kind: 'blocks',
        dependsOnKey: 'ISS-900',
        blockerStatus: 'closed',
        blockerMergedAt: null,
        edgeValidUntil: null,
      },
    ]);
    expect(row).not.toHaveProperty('satisfied');
  });

  // cm:guard "no work has been opened for this issue" and NOTHING else. A dependency filter, a priority ordering or a cap beyond the project's own `limit` are the master's judgements — a backlog that pre-decides them is the kernel routing again through a second door.
  it('excludes issues that already carry a job or an open run, and nothing more', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'], limit: 3 } })]);
    execute.mockResolvedValueOnce([]);
    await readBacklog({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(q).toContain('jobs');
    expect(q).toContain('pipeline_runs');
    expect(q).toContain('running');
    expect(q).toContain('paused');
    expect(q).toContain('draft');
    expect(q).not.toContain('issue_dependencies b');
    expect(q).toContain('created_at');
  });

  it('tolerates an issue with no iss_seq', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    execute.mockResolvedValueOnce([issueRow({ iss_seq: null })]);
    const [row] = await readBacklog({ deviceId: DEVICE });
    expect(row?.issueKey).toBeNull();
  });
});
