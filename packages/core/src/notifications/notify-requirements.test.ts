import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  holders: ['ba-1', 'agent-1'] as string[],
  notices: [] as Record<string, unknown>[],
  resolved: [] as [string, string | undefined][],
  /** The step change the next read finds, per requirement; told once, then read as none. */
  changes: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../permissions/index.js', () => ({
  holdersOf: async (permission: string, ids: string[]) => {
    if (permission !== 'requirements.approve') throw new Error(`asked for ${permission}`);
    return new Map(ids.map((id) => [id, state.holders]));
  },
}));
vi.mock('./emit.js', () => ({
  emitNotification: async (n: Record<string, unknown>) => {
    state.notices.push(n);
    return { id: 'n1', delivered: 1 };
  },
}));
vi.mock('./auto-resolve.js', () => ({
  resolveNotifications: async (key: string, outcome?: string) => {
    state.resolved.push([key, outcome]);
    return 1;
  },
}));
vi.mock('../issues/index.js', () => ({ userLabel: async () => 'Bea' }));
vi.mock('../requirements/index.js', () => ({
  requirementOfIssue: async (issueId: string) =>
    issueId === 'i1' ? { requirementId: 'r9' } : null,
  stepChangeOf: async (id: string, tell: (c: unknown) => Promise<void>) => {
    const change = state.changes.get(id);
    if (!change) return null;
    await tell(change);
    state.changes.delete(id);
    return change;
  },
}));

const { consumerOf } = await import('../outbox/consumers.js');
const { registerRequirementNotifications } = await import('./notify-requirements.js');

describe('the BA notice of a delivered requirement', () => {
  beforeAll(() => registerRequirementNotifications());

  it('tells every holder of requirements.approve, once per delivered revision', async () => {
    await consumerOf('requirement.delivered', 'notify-requirements')?.handle(
      { projectId: 'p1', requirementId: 'r1', key: 'REQ-3', title: 'Export', revision: 2 },
      {} as never,
    );
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toMatchObject({
      recipients: ['ba-1', 'agent-1'],
      type: 'requirement_delivered',
      title: 'REQ-3 r2 is delivered: Export',
      resolutionKey: 'requirement-check:r1@r2',
      dedupeKey: 'requirement-delivered:r1@r2',
    });
  });

  it('is resolved by the accept of that revision', async () => {
    await consumerOf('requirement.accepted', 'notify-requirements')?.handle(
      { projectId: 'p1', requirementId: 'r1', key: 'REQ-3', revision: 2, acceptedBy: 'u1' },
      {} as never,
    );
    expect(state.resolved).toEqual([['requirement-check:r1@r2', 'REQ-3 r2 accepted by Bea']]);
  });
});

// REQ-34 BC-21: every step change of a requirement tells its author, once, with the step after it
describe('the author notice of a step change', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    projectId: 'p1',
    requirementId: 'r9',
    key: 'REQ-9',
    title: 'Cards export',
    from: 'draft',
    to: 'agreed',
    next: 'in_delivery',
    authorId: 'lan',
    ...over,
  });
  const told = () => state.notices.filter((n) => n.type === 'requirement_step');

  beforeAll(() => {
    state.notices.length = 0;
  });

  it('a stored move tells the author the step and the one after it, and only the author', async () => {
    state.changes.set('r9', change());
    await consumerOf('requirement.transitioned', 'notify-requirements')?.handle(
      { entity: 'requirement', id: 'r9', at: '2026-10-10T00:00:00Z' } as never,
      {} as never,
    );
    expect(told()).toEqual([
      expect.objectContaining({
        userId: 'lan',
        type: 'requirement_step',
        title: 'REQ-9 is Agreed: Cards export',
        body: 'Next: In delivery.',
        dedupeKey: 'requirement-step:r9:draft>agreed:2026-10-10T00:00:00Z',
      }),
    ]);
  });

  it("a linked issue's move tells a delivery phase, and an unlinked one reads nothing", async () => {
    state.changes.set('r9', change({ from: 'agreed', to: 'in_delivery', next: 'delivered' }));
    const issueStep = consumerOf('issue.transitioned', 'notify-requirement-step');
    await issueStep?.handle({ id: 'i2', at: 't' } as never, {} as never);
    expect(told()).toHaveLength(1);
    await issueStep?.handle({ id: 'i1', at: 't' } as never, {} as never);
    expect(told().at(-1)).toMatchObject({
      title: 'REQ-9 is In delivery: Cards export',
      body: 'Next: Delivered.',
    });
  });

  it("an end step says nothing comes after it, and an agent's requirement tells nobody", async () => {
    state.changes.set('r9', change({ from: 'agreed', to: 'dropped', next: null }));
    await consumerOf('requirement.transitioned', 'notify-requirements')?.handle(
      { id: 'r9', at: 't2' } as never,
      {} as never,
    );
    expect(told().at(-1)).toMatchObject({ title: 'REQ-9 is Dropped: Cards export', body: null });
    const before = told().length;
    state.changes.set('r9', change({ authorId: null }));
    await consumerOf('requirement.transitioned', 'notify-requirements')?.handle(
      { id: 'r9', at: 't3' } as never,
      {} as never,
    );
    expect(told()).toHaveLength(before);
  });
});
