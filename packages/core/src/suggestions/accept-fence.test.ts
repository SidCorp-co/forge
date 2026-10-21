// The steward's accept fence (REQ-48 r2 decision 2, amended 2026-10-21): the steward accepts only the
// feedback triage it proposed itself, never a breakdown or anyone else's suggestion; a person's or any
// other account's accept is not the fence's to judge.

import { describe, expect, it, vi } from 'vitest';

const stewardOf = vi.hoisted(() =>
  vi.fn(async (_projectId: string) => 'steward-1' as string | null),
);
vi.mock('./ports.js', () => ({ suggestionsPorts: () => ({ stewardOf }) }));

const { acceptFenceRefusal, stewardAcceptRefusal } = await import('./accept-fence.js');

const asked = (kind: string, actorId: string, producerId: string | null) => ({
  projectId: 'p1',
  actorId,
  kind,
  producerId,
});

describe("the steward's accept fence", () => {
  it('refuses the steward accepting a breakdown, by name', () => {
    const refused = stewardAcceptRefusal('steward-1', asked('breakdown', 'steward-1', 'master-1'));
    expect(refused).toMatchObject({
      code: 'PERMISSION_FORBIDDEN',
      permission: 'suggestions.approve',
    });
    expect(refused?.detail).toContain('never accept one');
  });

  it('refuses the steward accepting its own suggestion of any other kind, and a triage another proposed', () => {
    expect(
      stewardAcceptRefusal('steward-1', asked('breakdown', 'steward-1', 'steward-1')),
    ).not.toBeNull();
    expect(
      stewardAcceptRefusal('steward-1', asked('requirement_draft', 'steward-1', 'steward-1')),
    ).not.toBeNull();
    expect(
      stewardAcceptRefusal('steward-1', asked('feedback_triage', 'steward-1', 'assistant-1'))
        ?.detail,
    ).toContain('a feedback triage another proposed');
  });

  it('lets the steward accept the feedback triage it proposed', () => {
    expect(
      stewardAcceptRefusal('steward-1', asked('feedback_triage', 'steward-1', 'steward-1')),
    ).toBeNull();
  });

  it('leaves every other accepter, and a project with no steward, to the permission check', async () => {
    expect(
      stewardAcceptRefusal('steward-1', asked('breakdown', 'person-1', 'master-1')),
    ).toBeNull();
    expect(stewardAcceptRefusal(null, asked('breakdown', 'steward-1', 'master-1'))).toBeNull();
    stewardOf.mockClear();
    expect(await acceptFenceRefusal('human', asked('breakdown', 'steward-1', null))).toBeNull();
    expect(stewardOf).not.toHaveBeenCalled();
    expect(await acceptFenceRefusal('agent', asked('breakdown', 'steward-1', null))).not.toBeNull();
  });
});
