// `db.execute` is mocked (no Postgres), so ranking and the JOINs themselves are
// the database's business. What these tests own is `backlog.ts`'s own logic:
// which projects contribute an admission at all, what the SQL is asked to
// exclude, and the shape a master is handed.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();

const projectionRows: unknown[] = [];
const select = vi.fn(() => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => projectionRows,
  };
  return chain;
});

vi.mock('../db/client.js', () => ({ db: { execute, select } }));

const { readAdmissibleIssues, readAdmissions } = await import('./admissible.js');
const { BLOCKER_SETTLED_STATUSES, DISPATCH_GATING_KIND } = await import(
  '../issues/dependency-effects.js'
);

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

describe('readAdmissions', () => {
  it('admits the entry status even when no poolBacklog is declared', async () => {
    execute.mockResolvedValueOnce([projectRow({ enabled: true })]);
    await expect(readAdmissions({ deviceId: DEVICE })).resolves.toEqual([
      { projectId: PROJECT, statuses: ['open'], limit: 20, entryOnRelease: false },
    ]);
  });

  it('admits the entry status beside a declared backlog, never instead of it', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    const [a] = await readAdmissions({ deviceId: DEVICE });
    expect(a?.statuses).toEqual(['draft', 'open']);
  });

  it('withholds the entry status while a human holds the gate', async () => {
    execute.mockResolvedValueOnce([
      projectRow({ states: { open: { mode: 'manual' } }, poolBacklog: { statuses: ['draft'] } }),
    ]);
    const [a] = await readAdmissions({ deviceId: DEVICE });
    expect(a?.statuses).toEqual(['draft']);
    expect(
      a?.entryOnRelease,
      'a gate is per project and a Run is per issue, so a gated project must still be able to offer the ONE issue a human released — without this the only way to release one is to open the gate for all of them',
    ).toBe(true);
  });

  it('reads the declared statuses and the declared limit', async () => {
    execute.mockResolvedValueOnce([
      projectRow({ poolBacklog: { statuses: ['draft', 'on_hold'], limit: 7 } }),
    ]);
    await expect(readAdmissions({ deviceId: DEVICE })).resolves.toEqual([
      {
        projectId: PROJECT,
        statuses: ['draft', 'on_hold', 'open'],
        limit: 7,
        entryOnRelease: false,
      },
    ]);
  });

  it('defaults the limit when the project declared none', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    const [a] = await readAdmissions({ deviceId: DEVICE });
    expect(a?.limit).toBe(20);
  });

  it('reads a config the canonical schema rejects as no backlog at all', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['open'] } })]);
    await expect(readAdmissions({ deviceId: DEVICE })).resolves.toEqual([]);
  });

  it('scopes the project read through this device runners binding', async () => {
    execute.mockResolvedValueOnce([]);
    await readAdmissions({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain('runners');
    expect(q).toContain(DEVICE);
  });

  it('narrows to one project when the caller named one', async () => {
    execute.mockResolvedValueOnce([]);
    await readAdmissions({ deviceId: DEVICE, projectId: PROJECT });
    const q = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(q).toContain(PROJECT);
  });
});

describe('readAdmissibleIssues', () => {
  it('asks the database nothing when a gated project declares no backlog either', async () => {
    execute.mockResolvedValueOnce([projectRow({ states: { open: { mode: 'manual' } } })]);
    await expect(readAdmissibleIssues({ deviceId: DEVICE })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns rows carrying no job id', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    execute.mockResolvedValueOnce([issueRow()]);
    const [row] = await readAdmissibleIssues({ deviceId: DEVICE });
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
    const [row] = await readAdmissibleIssues({ deviceId: DEVICE });
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

  it('excludes issues that already carry a job or an open run, and nothing more', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'], limit: 3 } })]);
    execute.mockResolvedValueOnce([]);
    await readAdmissibleIssues({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(q).toContain('jobs');
    expect(q).toContain('pipeline_runs');
    expect(q).toContain('running');
    expect(q).toContain('paused');
    expect(q).toContain('draft');
    expect(q).toContain('created_at');
    expect(q).not.toContain('repo_pull_requests');
    expect(q).not.toContain('merged_at IS');
  });

  describe('the blocks clause ISS-1100 added', () => {
    async function blockedQuery(): Promise<string> {
      execute.mockResolvedValueOnce([
        projectRow({ poolBacklog: { statuses: ['draft'], limit: 3 } }),
      ]);
      execute.mockResolvedValueOnce([]);
      await readAdmissibleIssues({ deviceId: DEVICE });
      return JSON.stringify(execute.mock.calls[1]?.[0]);
    }

    it('asks the edge table about this issue', async () => {
      const q = await blockedQuery();
      expect(q).toContain('issue_dependencies');
      expect(q).toContain('d.to_issue_id = i.id');
    });

    it('narrows to the one kind that gates dispatch', async () => {
      const q = await blockedQuery();
      expect(q).toContain('d.kind =');
      expect(q).toContain(DISPATCH_GATING_KIND);
    });

    it('ignores an edge whose validity has run out', async () => {
      const q = await blockedQuery();
      expect(q).toContain('d.valid_until IS NULL OR d.valid_until > now()');
    });

    it('releases the row on exactly the settled statuses', async () => {
      const q = await blockedQuery();
      expect(q).toContain('b.status NOT IN');
      for (const status of BLOCKER_SETTLED_STATUSES) {
        expect(q).toContain(status);
      }
    });

    it('correlates on the admitting project so the composite index stays usable', async () => {
      const q = await blockedQuery();
      expect(q).toContain('d.project_id =');
    });
  });

  it('tolerates an issue with no iss_seq', async () => {
    execute.mockResolvedValueOnce([projectRow({ poolBacklog: { statuses: ['draft'] } })]);
    execute.mockResolvedValueOnce([issueRow({ iss_seq: null })]);
    const [row] = await readAdmissibleIssues({ deviceId: DEVICE });
    expect(row?.issueKey).toBeNull();
  });
});
