import { beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  holders: ['ba-1', 'agent-1'] as string[],
  notices: [] as Record<string, unknown>[],
  resolved: [] as [string, string | undefined][],
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
