import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../knowledge/index.js', () => ({ itemEmbeddingOf: vi.fn(), nearestItems: vi.fn() }));

const { nearDuplicateRefusal } = await import('./near-duplicate.js');
const { duplicateTargetRefusal } = await import('./acceptance-rules.js');

describe('requirement-to-delivery ready: a near-duplicate waits on a decided duplicate suggestion', () => {
  it('agrees when nothing near is found', () => {
    expect(nearDuplicateRefusal('REQ-3', [])).toBeNull();
  });

  it('agrees once every near-duplicate has a decided duplicate suggestion', () => {
    expect(
      nearDuplicateRefusal('REQ-3', [
        { key: 'REQ-1', similarity: 0.95, decided: true, pendingId: null },
      ]),
    ).toBeNull();
  });

  it('refuses REQUIREMENT_DUPLICATE_UNDECIDED naming the near REQ, its similarity and the open suggestion', () => {
    const r = nearDuplicateRefusal('REQ-3', [
      { key: 'REQ-1', similarity: 0.95, decided: true, pendingId: null },
      { key: 'REQ-2', similarity: 0.93, decided: false, pendingId: 'sugg-9' },
      { key: 'REQ-4', similarity: 0.91, decided: false, pendingId: null },
    ]);
    expect(r?.code).toBe('REQUIREMENT_DUPLICATE_UNDECIDED');
    expect(r?.detail).toContain('REQ-2 (similarity 0.93, duplicate suggestion sugg-9 is proposed)');
    expect(r?.detail).toContain('REQ-4 (similarity 0.91, no duplicate suggestion proposed)');
    expect(r?.detail).not.toContain('REQ-1');
  });
});

describe('suggestion-lifecycle start: a duplicate on a requirement names another live requirement', () => {
  const original = { id: 'a', reqSeq: 1, status: 'agreed' };

  it('accepts another live requirement', () => {
    expect(duplicateTargetRefusal('b', original, 'REQ-1')).toBeNull();
  });

  it('refuses an unknown requirement by name', () => {
    const r = duplicateTargetRefusal('b', null, 'REQ-99');
    expect(r?.code).toBe('REQUIREMENT_DUPLICATE_TARGET_INVALID');
    expect(r?.detail).toContain('REQ-99 is not a requirement of this project');
  });

  it('refuses itself', () => {
    expect(duplicateTargetRefusal('a', original, 'REQ-1')?.code).toBe(
      'REQUIREMENT_DUPLICATE_TARGET_INVALID',
    );
  });

  it('refuses a dropped original', () => {
    const r = duplicateTargetRefusal('b', { ...original, status: 'dropped' }, 'REQ-1');
    expect(r?.detail).toContain('is dropped');
  });
});

describe('requirement-to-delivery ready: agree files the duplicate suggestion itself', () => {
  const row = { id: 'req-3', projectId: 'p', currentRevision: 2 };
  const actor = { userId: 'u', agency: 'human' as const };

  it('files one for each undecided near-duplicate with none proposed, and the refusal names it', async () => {
    const { fileUndecidedDuplicates } = await import('./near-duplicate.js');
    const calls: unknown[] = [];
    const near = await fileUndecidedDuplicates(
      row,
      actor,
      [
        { key: 'REQ-1', similarity: 0.95, decided: true, pendingId: null },
        { key: 'REQ-2', similarity: 0.93, decided: false, pendingId: 'sugg-9' },
        { key: 'REQ-4', similarity: 0.91, decided: false, pendingId: null },
      ],
      async (input) => {
        calls.push(input);
        return { ok: true, id: 'sugg-new' };
      },
    );
    expect(calls).toEqual([
      {
        projectId: 'p',
        requirementId: 'req-3',
        baseRevision: 2,
        duplicateOf: 'REQ-4',
        similarity: 0.91,
        actor,
      },
    ]);
    const r = nearDuplicateRefusal('REQ-3', near);
    expect(r?.code).toBe('REQUIREMENT_DUPLICATE_UNDECIDED');
    expect(r?.detail).toContain(
      'REQ-4 (similarity 0.91, duplicate suggestion sugg-new was filed by this agree)',
    );
    expect(r?.detail).toContain('REQ-2 (similarity 0.93, duplicate suggestion sugg-9 is proposed)');
  });

  it('names a filing the suggestions door refused, never a silent miss', async () => {
    const { fileUndecidedDuplicates } = await import('./near-duplicate.js');
    const near = await fileUndecidedDuplicates(
      row,
      actor,
      [{ key: 'REQ-4', similarity: 0.91, decided: false, pendingId: null }],
      async () => ({ ok: false, refused: 'SUGGESTION_DUPLICATE: a twin is proposed' }),
    );
    expect(nearDuplicateRefusal('REQ-3', near)?.detail).toContain(
      'no duplicate suggestion could be filed (SUGGESTION_DUPLICATE: a twin is proposed)',
    );
  });
});
