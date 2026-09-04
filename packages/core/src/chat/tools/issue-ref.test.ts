import { describe, expect, it, vi } from 'vitest';
import { type IssueLookupDb, resolveIssueDisplayId } from './issue-ref.js';

function fakeDb(rows: Array<{ id: string }>): {
  db: IssueLookupDb;
  where: ReturnType<typeof vi.fn>;
} {
  const where = vi.fn(() => ({ limit: async () => rows }));
  const db = { select: () => ({ from: () => ({ where }) }) } as unknown as IssueLookupDb;
  return { db, where };
}

describe('resolveIssueDisplayId', () => {
  it('rewrites ISS-<n> (any case, padded) to the UUID of that issue in the bound project', async () => {
    const { db } = fakeDb([{ id: 'uuid-3' }]);
    const args: Record<string, unknown> = { action: 'get', documentId: ' iss-3 ' };
    expect(await resolveIssueDisplayId(db, 'p1', args)).toBeNull();
    expect(args.documentId).toBe('uuid-3');
  });

  it('rejects an ISS id the project does not have, naming it', async () => {
    const { db } = fakeDb([]);
    const args: Record<string, unknown> = { documentId: 'ISS-99' };
    expect(await resolveIssueDisplayId(db, 'p1', args)).toBe('no issue ISS-99 in this project');
    expect(args.documentId).toBe('ISS-99');
  });

  it('leaves a UUID, a missing id and a non-string alone without touching the database', async () => {
    const { db, where } = fakeDb([{ id: 'never' }]);
    for (const documentId of ['0b3c1c6e-1111-4111-8111-111111111111', undefined, 7]) {
      const args: Record<string, unknown> = { documentId };
      expect(await resolveIssueDisplayId(db, 'p1', args)).toBeNull();
      expect(args.documentId).toBe(documentId);
    }
    expect(where).not.toHaveBeenCalled();
  });
});
