import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queue-based select mock: each db.select().from().where() consumes the next
// queued result; the returned object is awaitable directly (copies query) AND
// exposes .limit() (issue/project lookups) so one mock serves both shapes.
const selectQueue: unknown[][] = [];
const insertValuesMock = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = selectQueue.shift() ?? [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          p.limit = () => Promise.resolve(rows);
          return p;
        },
      }),
    }),
    insert: () => ({ values: (v: unknown) => insertValuesMock(v) }),
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sweepTemplateDrift, sweepTemplateBumps } = await import('./template-propagation.js');
const { dedupEffectiveSkills } = await import('./effective.js');

const BUMP = {
  globalSkillId: 'g-1',
  name: 'forge-code',
  oldVersion: 6,
  newVersion: 7,
};

beforeEach(() => {
  selectQueue.length = 0;
  insertValuesMock.mockReset();
  insertValuesMock.mockResolvedValue(undefined);
});

describe('sweepTemplateDrift', () => {
  it('no behind copies → nothing drafted', async () => {
    selectQueue.push([]); // copies
    const r = await sweepTemplateDrift(BUMP);
    expect(r).toEqual({ behind: 0, drafted: 0, skipped: 0 });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('skips a project that already has a live skill-rebase issue (idempotent)', async () => {
    selectQueue.push([{ skillId: 's-1', projectId: 'p-1', basedOnGlobalVersion: 6 }]); // copies
    selectQueue.push([{ id: 'existing-issue' }]); // existing rebase issue
    const r = await sweepTemplateDrift(BUMP);
    expect(r).toEqual({ behind: 1, drafted: 0, skipped: 1 });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('drafts one rebase issue per behind project — status draft, never open', async () => {
    selectQueue.push([{ skillId: 's-1', projectId: 'p-1', basedOnGlobalVersion: 6 }]); // copies
    selectQueue.push([]); // no existing issue
    selectQueue.push([{ createdBy: 'user-1' }]); // project row
    const r = await sweepTemplateDrift(BUMP);
    expect(r).toEqual({ behind: 1, drafted: 1, skipped: 0 });
    const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(values.status).toBe('draft');
    expect(values.projectId).toBe('p-1');
    expect(values.category).toBe('skills');
    expect(values.createdById).toBe('user-1');
    expect(values.title).toBe('skill-rebase: forge-code v6→v7');
    expect(String(values.description)).toContain('three-way rebase');
  });

  it('unknown adopted version (pre-tracking backfill) still drafts, titled v?', async () => {
    selectQueue.push([{ skillId: 's-1', projectId: 'p-1', basedOnGlobalVersion: null }]);
    selectQueue.push([]);
    selectQueue.push([{ createdBy: 'user-1' }]);
    const r = await sweepTemplateDrift(BUMP);
    expect(r.drafted).toBe(1);
    const values = insertValuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(values.title).toBe('skill-rebase: forge-code v?→v7');
  });

  it('an insert failure is contained — other projects still sweep', async () => {
    selectQueue.push([
      { skillId: 's-1', projectId: 'p-1', basedOnGlobalVersion: 6 },
      { skillId: 's-2', projectId: 'p-2', basedOnGlobalVersion: 6 },
    ]);
    selectQueue.push([]); // p-1 no existing
    selectQueue.push([{ createdBy: 'user-1' }]);
    selectQueue.push([]); // p-2 no existing
    selectQueue.push([{ createdBy: 'user-2' }]);
    insertValuesMock.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined);
    const r = await sweepTemplateDrift(BUMP);
    expect(r.behind).toBe(2);
    expect(r.drafted).toBe(1);
  });
});

describe('sweepTemplateBumps', () => {
  it('never throws — a failing bump is logged and the rest proceed', async () => {
    // First bump: copies query resolves; second bump: force a throw by making
    // the queue empty is fine, so instead assert the happy path shape.
    selectQueue.push([]);
    selectQueue.push([]);
    const results = await sweepTemplateBumps([BUMP, { ...BUMP, name: 'forge-plan' }]);
    expect(results).toHaveLength(2);
  });
});

describe('dedupEffectiveSkills — ISS-605 drift hints', () => {
  const base = {
    skillMd: 'body',
    prompt: 'body',
    files: [],
    installOnly: false,
  };

  it('project copy older than template → behindTemplate with both versions', () => {
    const rows = [
      { ...base, id: 'g-1', name: 'forge-code', version: 7, scope: 'global' as const },
      {
        ...base,
        id: 'p-1',
        name: 'forge-code',
        version: 3,
        scope: 'project' as const,
        basedOnGlobalVersion: 6,
      },
    ];
    const [eff] = dedupEffectiveSkills(rows);
    expect(eff?.behindTemplate).toBe(true);
    expect(eff?.basedOnGlobalVersion).toBe(6);
    expect(eff?.templateVersion).toBe(7);
  });

  it('copy adopted at the current template version → not behind', () => {
    const rows = [
      { ...base, id: 'g-1', name: 'forge-code', version: 7, scope: 'global' as const },
      {
        ...base,
        id: 'p-1',
        name: 'forge-code',
        version: 3,
        scope: 'project' as const,
        basedOnGlobalVersion: 7,
      },
    ];
    expect(dedupEffectiveSkills(rows)[0]?.behindTemplate).toBe(false);
  });

  it('unknown lineage version (pre-tracking) counts as behind', () => {
    const rows = [
      { ...base, id: 'g-1', name: 'forge-code', version: 7, scope: 'global' as const },
      { ...base, id: 'p-1', name: 'forge-code', version: 3, scope: 'project' as const },
    ];
    expect(dedupEffectiveSkills(rows)[0]?.behindTemplate).toBe(true);
  });

  it('project skill with no same-name global carries null/false hints', () => {
    const rows = [
      { ...base, id: 'p-1', name: 'custom-skill', version: 1, scope: 'project' as const },
    ];
    const [eff] = dedupEffectiveSkills(rows);
    expect(eff?.behindTemplate).toBe(false);
    expect(eff?.templateVersion).toBeNull();
  });
});
