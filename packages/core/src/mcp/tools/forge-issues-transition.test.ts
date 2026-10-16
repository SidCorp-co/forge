/**
 * ISS-1229 r11 — an update's refusal says nothing was written only where nothing was: a failure
 * raised after the update committed is passed on in its own words.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const committed = { value: false };
const after = { fail: false };

vi.mock('../../issues/update-service.js', () => ({
  writeIssueFieldsIn: async () => ({ row: {}, wrote: true }),
  announceContractInput: async () => {
    if (after.fail) throw new Error('the bus went away');
  },
}));
vi.mock('../../issues/relations-service.js', () => ({
  writeIssueRelations: async () => [],
  writeBesideRelations: async (
    _w: unknown,
    _p: unknown,
    _i: unknown,
    _r: unknown,
    before: (tx: unknown) => Promise<unknown>,
  ) => {
    const wrote = await before({});
    committed.value = true;
    return { wrote, pending: [] };
  },
  flushIssueRelationEffects: async () => {},
}));
vi.mock('../../issues/apply-transition.js', () => ({
  transitionIssueStatus: async (
    _issue: unknown,
    _status: unknown,
    _actor: unknown,
    options: { beforeStatusWrite?: (tx: unknown) => Promise<void> },
  ) => {
    await options.beforeStatusWrite?.({});
    committed.value = true;
    throw new Error('the hub went away');
  },
}));
vi.mock('./lib.js', () => ({ principalActor: () => ({ type: 'user', id: 'u' }) }));

const { moveWithWrites, writeWithoutMove } = await import('./forge-issues-transition.js');

const issue = { id: 'i', projectId: 'p' } as never;
const writes = {
  fields: { issueId: 'i', updates: { title: 't' }, actor: {} as never },
  relations: [],
  writer: {} as never,
};

beforeEach(() => {
  committed.value = false;
  after.fail = false;
});

describe('a failure after the update committed', () => {
  it('passes on in its own words where the status move failed after its commit', async () => {
    const err = await moveWithWrites(issue, 'confirmed', {} as never, {}, writes).catch(
      (e: Error) => e,
    );

    expect(committed.value).toBe(true);
    expect((err as Error).message).toBe('the hub went away');
  });

  it('passes on in its own words where announcing the write failed', async () => {
    after.fail = true;
    const err = await writeWithoutMove(issue, writes).catch((e: Error) => e);

    expect(committed.value).toBe(true);
    expect((err as Error).message).toBe('the bus went away');
  });
});
