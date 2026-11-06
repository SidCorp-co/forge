// JU-2: hop REQ-19 read 'Issues done 0/6' on the requirements list and '5/6 landed' on Releases,
// both 'xong' in Vietnamese. One count of each now: shipped, landed awaiting release, to do.
// ISS-1062: shipped is what a release record holds, never `closed`, which says met in scope.
import { describe, expect, it } from 'vitest';
import { issueProgressOf } from './progress.js';

type Row = { status: string; released?: boolean };
const rows = (...statuses: string[]): Row[] => statuses.map((status) => ({ status }));
const released = (r: Row) => r.released === true;

describe('a scope’s progress', () => {
  it('counts REQ-19 as none shipped, five landed waiting on the release, one to do', () => {
    expect(
      issueProgressOf(rows(...Array(5).fill('awaiting_release'), 'open'), released),
    ).toEqual({
      total: 6,
      shipped: 0,
      awaitingRelease: 5,
      toDo: 1,
    });
  });

  it('leaves a dropped issue out and counts every other status once', () => {
    const p = issueProgressOf(
      [
        { status: 'closed', released: true },
        ...rows('awaiting_release', 'in_progress', 'needs_info', 'draft', 'dropped'),
      ],
      released,
    );
    expect(p).toEqual({ total: 5, shipped: 1, awaitingRelease: 1, toDo: 3 });
    expect(p.shipped + p.awaitingRelease + p.toDo).toBe(p.total);
  });

  it('reads an issue its holder closed and no release carries as waiting on its release, never shipped', () => {
    const p = issueProgressOf(
      [{ status: 'closed', released: false }, { status: 'closed', released: true }],
      released,
    );
    expect(p).toEqual({ total: 2, shipped: 1, awaitingRelease: 1, toDo: 0 });
  });

  it('reads an empty scope as all zero', () => {
    expect(issueProgressOf([], released)).toEqual({
      total: 0,
      shipped: 0,
      awaitingRelease: 0,
      toDo: 0,
    });
  });
});
