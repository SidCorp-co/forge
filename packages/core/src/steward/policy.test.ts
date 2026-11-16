// The steward's runaway guard (ISS-1255): the one bound on what it does once the daily budget went.
// The same act on the same item runs `STEWARD_ACT_REPEAT_LIMIT` times on a standing that does not
// move, and the next is refused STEWARD_ACT_REPEATED, naming the item, the act and the count.
//
// @direct-test-of packages/core/src/steward/policy.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const held = { enabled: true as boolean, repeats: 0, started: [] as string[] };
vi.mock('../project-config/index.js', () => ({
  readProjectDocument: async () =>
    held.enabled ? null : { document: { steward: { enabled: false } } },
}));
vi.mock('./runs-store.js', () => ({
  REPEATED_CODE: 'STEWARD_ACT_REPEATED',
  repeatsOnBasis: async () => held.repeats,
  markStarted: async (id: string) => {
    held.started.push(id);
  },
}));

const { admitRun, repeatedRefusal, STEWARD_ACT_REPEAT_LIMIT } = await import('./policy.js');

const run = { id: 'r1', projectId: 'p1', subjectKind: 'feedback', subjectId: 'f1' };

beforeEach(() => {
  held.enabled = true;
  held.repeats = 0;
  held.started = [];
});

describe('the runaway guard', () => {
  it('admits an act one short of its limit on an unmoved standing, and starts the run', async () => {
    held.repeats = STEWARD_ACT_REPEAT_LIMIT - 1;
    expect(await admitRun(run, ['note'], 'b1')).toBeNull();
    expect(held.started).toEqual(['r1']);
  });

  it('refuses the act at its limit, naming the act and the count, and starts nothing', async () => {
    held.repeats = STEWARD_ACT_REPEAT_LIMIT;
    expect(await admitRun(run, ['note', 'triage_draft'], 'b1')).toEqual({
      repeated: { act: 'note', count: STEWARD_ACT_REPEAT_LIMIT, basis: 'b1' },
    });
    expect(held.started).toEqual([]);
  });

  it('never holds a run with no standing to compare as a repeat', async () => {
    held.repeats = STEWARD_ACT_REPEAT_LIMIT * 3;
    expect(await admitRun(run, ['release_followthrough'], null)).toBeNull();
  });

  it('skips every run of a project whose steward is off', async () => {
    held.enabled = false;
    expect(await admitRun(run, ['note'], 'b1')).toEqual({ skip: 'steward_off' });
  });

  it('words the refusal with its code, the item, the act and the count', () => {
    const text = repeatedRefusal(
      { subjectKey: 'FB-7' },
      { act: 'stuck_diagnosis', count: 6, basis: 'b9' },
    );
    expect(text).toMatch(/^STEWARD_ACT_REPEATED: stuck_diagnosis on FB-7 already ran 6 times/);
  });
});
