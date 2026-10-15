// The release sweep weighs every waiting issue's judged commit against what is served, every minute.
// Each answer about two commits is asked once: whether one descends from the other is one compare,
// files are paged only for commits that diverged, and a list too long to take whole stays known.

import { describe, expect, it } from 'vitest';
import type {
  HostCompare,
  HostFileCompare,
  SourceHost,
} from '../integrations/source-host/index.js';
import { carriageOf } from './carriage.js';

let repos = 0;

/** A host answering `status` for any pair, counting what it was asked. */
function host(status: HostCompare, files: HostFileCompare) {
  repos += 1;
  const asked = { compare: 0, compareFiles: 0 };
  const h = {
    fullName: `SidCorp-co/forge-${repos}`,
    compare: async () => {
      asked.compare += 1;
      return status;
    },
    compareFiles: async () => {
      asked.compareFiles += 1;
      return files;
    },
  } as unknown as SourceHost;
  return { h, asked };
}

const JUDGED = 'd5f27be2d0000000000000000000000000000000';
const SERVED = '6095cdd740000000000000000000000000000000';
const TOO_MANY = {
  why: '3000 or more files differ, and the repository names no more than that in one compare',
};

describe('carriage of a judged commit by the served one', () => {
  it('PLANT: a served commit that descends is one compare, and no file page', async () => {
    const { h, asked } = host('ahead', TOO_MANY);
    expect(await carriageOf(h, JUDGED, SERVED)).toEqual({ kind: 'descends' });
    expect(asked).toEqual({ compare: 1, compareFiles: 0 });
  });

  it('PLANT: a list too long to take whole is kept, never asked again each sweep', async () => {
    const { h, asked } = host('diverged', TOO_MANY);
    for (const _ of [1, 2, 3]) {
      expect(await carriageOf(h, JUDGED, SERVED)).toEqual({ kind: 'unread', why: TOO_MANY.why });
    }
    expect(asked).toEqual({ compare: 1, compareFiles: 1 });
  });

  it('names the paths two diverged commits differ in, from both sides', async () => {
    const files = { status: 'diverged' as const, files: ['b.ts', 'a.ts'], changes: [] };
    const { h, asked } = host('diverged', files);
    expect(await carriageOf(h, JUDGED, SERVED)).toEqual({
      kind: 'differs',
      paths: ['a.ts', 'b.ts'],
    });
    expect(asked).toEqual({ compare: 1, compareFiles: 2 });
  });

  it('never keeps a failed request: the next sweep asks again', async () => {
    let calls = 0;
    const h = {
      fullName: 'SidCorp-co/forge-down',
      compare: async () => {
        calls += 1;
        throw new Error('GitHub rate limit, resets at 2026-10-15T09:16:54.000Z');
      },
    } as unknown as SourceHost;
    const read = await carriageOf(h, JUDGED, SERVED);
    expect(read).toMatchObject({
      kind: 'unread',
      why: expect.stringContaining('GitHub rate limit'),
    });
    await carriageOf(h, JUDGED, SERVED);
    expect(calls).toBe(2);
  });
});
