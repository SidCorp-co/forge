// `db.execute` is mocked (no Postgres), so ranking and the JOINs themselves are
// the database's business. What these tests own is `admissible.ts`'s own logic:
// which projects contribute an admission at all, which are refused, what the SQL
// is asked to exclude, and the shape a master is handed.

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

const policies = new Map<string, unknown>();
vi.mock('../project-config/effective.js', () => ({
  readEffectivePolicy: vi.fn(async (projectId: string) => {
    const document = policies.get(projectId);
    return document ? { revision: 1, document } : null;
  }),
}));

const { readAdmissibleIssues, readAdmissions } = await import('./admissible.js');
const { BLOCKER_SETTLED_STATUSES, DISPATCH_GATING_KIND } = await import(
  '../issues/dependency-effects.js'
);

const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const projectRow = (id = PROJECT) => ({ id });

const policy = (mode: 'auto' | 'manual') => ({
  version: 1,
  qa: 'self',
  intake: { mode },
  permissions: { driver: { deny: [] } },
  states: { open: { model: 'opus', permissions: 'driver' } },
});

const issueRow = (over: Record<string, unknown> = {}) => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  iss_seq: 917,
  project_id: PROJECT,
  title: 'an issue nobody has started',
  description: null,
  priority: 'high',
  category: 'kernel-hardening',
  status: 'open',
  age_minutes: 12,
  relations: [],
  ...over,
});

beforeEach(() => {
  execute.mockReset();
  policies.clear();
  policies.set(PROJECT, policy('auto'));
});

describe('readAdmissions', () => {
  it('admits the entry status of a project whose policy intake is auto', async () => {
    execute.mockResolvedValueOnce([projectRow()]);
    await expect(readAdmissions({ deviceId: DEVICE })).resolves.toEqual({
      admissions: [{ projectId: PROJECT, limit: 20, entryOnRelease: false }],
      refused: [],
    });
  });

  it('admits only released entry issues while the policy intake is manual', async () => {
    policies.set(PROJECT, policy('manual'));
    execute.mockResolvedValueOnce([projectRow()]);
    const { admissions } = await readAdmissions({ deviceId: DEVICE });
    expect(
      admissions[0]?.entryOnRelease,
      'a gate is per project and a Run is per issue, so a gated project must still be able to offer the ONE issue a human released',
    ).toBe(true);
  });

  it('refuses a project with no policy by name, never leaving it out in silence', async () => {
    execute.mockResolvedValueOnce([projectRow(), projectRow(OTHER)]);
    const { admissions, refused } = await readAdmissions({ deviceId: DEVICE });
    expect(admissions.map((a) => a.projectId)).toEqual([PROJECT]);
    expect(refused).toEqual([
      {
        projectId: OTHER,
        code: 'POLICY_UNDECLARED',
        message: expect.stringContaining(`project ${OTHER} has no policy`),
      },
    ]);
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
  it('asks the database nothing for a project with no policy, and says so', async () => {
    policies.clear();
    execute.mockResolvedValueOnce([projectRow()]);
    const out = await readAdmissibleIssues({ deviceId: DEVICE });
    expect(out.items).toEqual([]);
    expect(out.refused.map((r) => r.code)).toEqual(['POLICY_UNDECLARED']);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reads only the released entry issues of a manual-intake project', async () => {
    policies.set(PROJECT, policy('manual'));
    execute.mockResolvedValueOnce([projectRow()]);
    execute.mockResolvedValueOnce([]);
    await readAdmissibleIssues({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(q).toContain("session_context ? 'runRelease'");
  });

  it('reads every entry issue of an auto-intake project', async () => {
    execute.mockResolvedValueOnce([projectRow()]);
    execute.mockResolvedValueOnce([]);
    await readAdmissibleIssues({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(q).not.toContain('runRelease');
  });

  it('returns rows carrying no job id', async () => {
    execute.mockResolvedValueOnce([projectRow()]);
    execute.mockResolvedValueOnce([issueRow()]);
    const {
      items: [row],
    } = await readAdmissibleIssues({ deviceId: DEVICE });
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('jobId');
    expect(row?.issueKey).toBe('ISS-917');
    expect(row?.status).toBe('open');
  });

  it('carries the raw blocker facts and never a computed verdict', async () => {
    execute.mockResolvedValueOnce([projectRow()]);
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
    const {
      items: [row],
    } = await readAdmissibleIssues({ deviceId: DEVICE });
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
    execute.mockResolvedValueOnce([projectRow()]);
    execute.mockResolvedValueOnce([]);
    await readAdmissibleIssues({ deviceId: DEVICE });
    const q = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(q).toContain('jobs');
    expect(q).toContain('pipeline_runs');
    expect(q).toContain('running');
    expect(q).toContain('paused');
    expect(q).toContain('open');
    expect(q).toContain('created_at');
    expect(q).not.toContain('repo_pull_requests');
    expect(q).not.toContain('merged_at IS');
  });

  describe('the blocks clause ISS-1100 added', () => {
    async function blockedQuery(): Promise<string> {
      execute.mockResolvedValueOnce([projectRow()]);
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
    execute.mockResolvedValueOnce([projectRow()]);
    execute.mockResolvedValueOnce([issueRow({ iss_seq: null })]);
    const {
      items: [row],
    } = await readAdmissibleIssues({ deviceId: DEVICE });
    expect(row?.issueKey).toBeNull();
  });
});
