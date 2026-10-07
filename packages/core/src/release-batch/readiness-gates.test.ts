// Project settings reads a release's reasons the way a release's own page does: each blocker and
// warning as a title, a sentence and who owes the act (`gateViews`), so an empty roster reads as
// "Nothing at the gate" in words rather than as its code.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => ({
  projectExists: true,
  declaration: null,
  channels: [],
  blockers: [
    {
      code: 'RELEASE_ROSTER_EMPTY',
      message: 'Nothing is waiting at the release gate.',
      details: {},
      evaluated: true,
    },
  ],
  warnings: [],
}));

vi.mock('./blockers.js', () => ({
  collectReleaseBlockers: vi.fn(async () => report),
  releaseBlockerSentence: vi.fn(() => 'unevaluated'),
}));
vi.mock('./serving-reading.js', () => ({ readServingNow: vi.fn(async () => undefined) }));
vi.mock('./runtime-weighing.js', () => ({ readWeighingNow: vi.fn() }));
vi.mock('./channel.js', () => ({ releaseRunnerLabelOf: vi.fn(() => null) }));
vi.mock('../knowledge/index.js', () => ({ selectAllSlugsFromKnowledge: vi.fn(async () => []) }));
vi.mock('../project-config/index.js', () => ({
  readDeclaredSource: vi.fn(async () => ({ repository: null })),
}));
vi.mock('../projects/index.js', () => ({ missingProjectKnowledge: vi.fn(() => []) }));

const { loadReleaseReadiness } = await import('./readiness.js');

describe('release readiness carries each reason as a person reads it', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads an empty roster as its title and sentence, owed by the master', async () => {
    const r = await loadReleaseReadiness('p1');
    expect(r?.gates).toEqual([
      expect.objectContaining({
        code: 'RELEASE_ROSTER_EMPTY',
        kind: 'blocker',
        title: 'Nothing at the gate',
        sentence: 'No issue is waiting at the release gate, so there is nothing to cut.',
        owner: expect.objectContaining({ who: 'Master' }),
      }),
    ]);
  });
});
