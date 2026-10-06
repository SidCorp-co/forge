import { describe, expect, it, vi } from 'vitest';

const P = '00000000-0000-4000-8000-000000000001';
const REVISED = '00000000-0000-4000-8000-0000000000a2';
const moved = {
  code: 'SUGGESTION_BASE_MOVED',
  path: '/baseRevision',
  detail: 'FB-2 moved since the revision was written',
};

vi.mock('./propose.js', () => ({
  createSuggestion: vi.fn(),
  reviseSuggestion: vi.fn(async () => ({
    ok: true,
    created: true,
    suggestion: { id: REVISED, kind: 'feedback_triage', status: 'proposed' },
  })),
}));
vi.mock('../permissions/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  permissionRefusalFor: vi.fn(async () => null),
}));
vi.mock('./read.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rowOf: vi.fn(async () => ({ id: REVISED, kind: 'feedback_triage', status: 'proposed' })),
  targetOfRow: vi.fn(() => ({ type: 'feedback', id: 'f-2' })),
}));
vi.mock('./write.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  inTx: vi.fn(async () => [moved]),
}));

const { reviseSuggestion } = await import('./service.js');

describe('reviseSuggestion: a reviewer who may route is told why the accept in the same act was refused (R1-05)', () => {
  it('answers the revision at proposed with the refused accept named by code and message', async () => {
    const out = await reviseSuggestion({
      projectId: P,
      id: '00000000-0000-4000-8000-0000000000a1',
      actor: { userId: 'u-1', agency: 'human' },
      payload: {},
      reason: 'route it to ISS-9',
    });
    expect(out.ok && out.suggestion.status).toBe('proposed');
    if (!out.ok) throw new Error('expected the revision');
    expect(out.acceptRefused?.code).toBe('SUGGESTION_BASE_MOVED');
    expect(out.acceptRefused?.message).toContain('FB-2 moved since the revision was written');
    expect(out.acceptRefused?.refusals).toEqual([moved]);
  });
});
