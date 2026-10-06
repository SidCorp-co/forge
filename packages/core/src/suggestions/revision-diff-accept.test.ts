import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock('../requirements/index.js', () => ({
  createRequirementIn: vi.fn(),
  dropAsDuplicateIn: vi.fn(),
  newRevisionIn: async (_tx: unknown, input: Record<string, unknown>) => {
    state.calls.push(input);
    return null;
  },
  rowIn: async () => ({ id: 'r1', reqSeq: 1 }),
}));
vi.mock('../lifecycle/index.js', () => ({ transition: async () => [] }));

const { writeEffect } = await import('./effects.js');

const tx = {
  select: () => ({ from: () => ({ where: async () => [{ revision: 2 }] }) }),
};
const row = {
  id: 's1',
  kind: 'revision_diff',
  requirementId: 'r1',
  baseRevision: 1,
  producerId: 'agent-1',
  payload: { reason: 'FB-1 asks for it', criteria: [{ code: 'BC-1', body: 'it holds' }] },
};

describe('accepting a revision_diff is the revision propose (feedback-triage revision)', () => {
  it('lands the revision proposed by the accepting person, authored by the producer', async () => {
    state.calls.length = 0;
    const out = await writeEffect(
      tx as never,
      'p1',
      row as never,
      1,
      { userId: 'ba-1', agency: 'human' } as never,
      'web',
    );
    expect(out.refusals).toBeNull();
    expect(state.calls[0]?.landing).toEqual({ state: 'proposed', proposedBy: 'ba-1' });
    expect(state.calls[0]?.actor).toMatchObject({ userId: 'agent-1' });
    expect(out.effect).toMatchObject({ requirement: 'REQ-1', revision: 2, state: 'proposed' });
  });
});
