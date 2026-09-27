/**
 * The name an issue is shown under, read for a set in one go.
 *
 * `RELEASE_CRITERIA_UNEARNED` told an operator to act on three uuids that
 * appear on no list, no header and no url (ISS-1127), so what this returns is
 * the project's own prefix and sequence rather than the primary key.
 */

import { describe, expect, it, vi } from 'vitest';

const rows = vi.fn(async () => [] as unknown[]);
vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => rows() }) }) }) },
}));

const { issueDisplayIds } = await import('./display-ids.js');

describe('issueDisplayIds', () => {
  it('reads nothing for an empty set, so a caller with none makes no query', async () => {
    const out = await issueDisplayIds([]);

    expect(out.size).toBe(0);
    expect(rows).not.toHaveBeenCalled();
  });

  it('names each issue by its own project’s prefix, not by one shared guess', async () => {
    rows.mockResolvedValue([
      { id: 'u-1', issSeq: 1127, issuePrefix: 'ISS' },
      { id: 'u-2', issSeq: 4, issuePrefix: 'CORE' },
    ]);

    const out = await issueDisplayIds(['u-1', 'u-2']);

    expect(out.get('u-1')).toBe('ISS-1127');
    expect(out.get('u-2')).toBe('CORE-4');
  });

  it('leaves an issue the read did not return out of the map rather than guessing a name', async () => {
    rows.mockResolvedValue([{ id: 'u-1', issSeq: 1, issuePrefix: 'ISS' }]);

    const out = await issueDisplayIds(['u-1', 'u-gone']);

    expect(out.has('u-gone')).toBe(false);
  });

  it('reads on the transaction it is handed, not beside it on the pool', async () => {
    const txRows = vi.fn(async () => [{ id: 'u-1', issSeq: 3, issuePrefix: 'FD' }]);
    const tx = {
      select: () => ({ from: () => ({ innerJoin: () => ({ where: () => txRows() }) }) }),
    } as unknown as Parameters<typeof issueDisplayIds>[1];
    rows.mockClear();

    expect(await issueDisplayIds(['u-1'], tx)).toEqual(new Map([['u-1', 'FD-3']]));
    expect(txRows).toHaveBeenCalledTimes(1);
    expect(rows).not.toHaveBeenCalled();
  });

  it('falls back to the legacy prefix where the project declares none', async () => {
    rows.mockResolvedValue([{ id: 'u-1', issSeq: 7, issuePrefix: null }]);

    expect(await issueDisplayIds(['u-1'])).toEqual(new Map([['u-1', 'ISS-7']]));
  });
});
