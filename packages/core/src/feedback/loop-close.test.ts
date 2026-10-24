import { describe, expect, it } from 'vitest';
import { goneByRecord } from './loop-close.js';

const resolvedSince = new Date('2026-10-01T00:00:00Z');
const passing = { ref: 'REQ-3 BC-2', verdict: 'passing' as const, why: null, clip: null };

// Feedback lifecycle r14 loop-check: past the window, the record says what it reads about "is the
// problem gone?" with its sources, for a person to answer from; it never answers, nor assumes gone.
describe('loop close read from the record', () => {
  it('reads it gone where the violated criterion passes on the running build and nothing was filed since', () => {
    expect(goneByRecord({ criterion: passing, filedSince: [], resolvedSince })).toEqual({
      gone: true,
      why: 'the record reads it gone: REQ-3 BC-2 passes on the running build, and nothing was filed against it since 2026-10-01.',
    });
  });

  it('cannot answer for an item whose triage named no criterion', () => {
    expect(goneByRecord({ criterion: null, filedSince: [], resolvedSince }).gone).toBe(false);
  });

  it('cannot answer where the criterion does not pass on the running build', () => {
    for (const verdict of ['failing', 'stale', 'not_live', 'not_judged', 'gap', null] as const) {
      const answer = goneByRecord({
        criterion: { ...passing, verdict, why: null },
        filedSince: [],
        resolvedSince,
      });
      expect(answer).toEqual({
        gone: false,
        why: `REQ-3 BC-2 reads ${verdict ?? 'no verdict'} on the running build`,
      });
    }
  });

  it('cannot answer where feedback against the criterion arrived since it read resolved', () => {
    expect(
      goneByRecord({ criterion: passing, filedSince: ['FB-9', 'FB-11'], resolvedSince }),
    ).toEqual({
      gone: false,
      why: 'FB-9, FB-11 were filed against REQ-3 BC-2 since it read resolved',
    });
  });
});
