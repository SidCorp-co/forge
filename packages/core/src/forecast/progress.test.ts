// JU-2: hop REQ-19 read 'Issues done 0/6' on the requirements list and '5/6 landed' on Releases,
// both 'xong' in Vietnamese. One count of each now: shipped, landed awaiting release, to do.
import { describe, expect, it } from 'vitest';
import { issueProgressOf } from './progress.js';

const rows = (...statuses: string[]) => statuses.map((status) => ({ status }));

describe('a scope’s progress', () => {
  it('counts REQ-19 as none shipped, five landed waiting on the release, one to do', () => {
    expect(issueProgressOf(rows(...Array(5).fill('awaiting_release'), 'open'))).toEqual({
      total: 6,
      shipped: 0,
      awaitingRelease: 5,
      toDo: 1,
    });
  });

  it('leaves a dropped issue out and counts every other status once', () => {
    const p = issueProgressOf(
      rows('closed', 'awaiting_release', 'in_progress', 'needs_info', 'draft', 'dropped'),
    );
    expect(p).toEqual({ total: 5, shipped: 1, awaitingRelease: 1, toDo: 3 });
    expect(p.shipped + p.awaitingRelease + p.toDo).toBe(p.total);
  });

  it('reads an empty scope as all zero', () => {
    expect(issueProgressOf([])).toEqual({ total: 0, shipped: 0, awaitingRelease: 0, toDo: 0 });
  });
});
