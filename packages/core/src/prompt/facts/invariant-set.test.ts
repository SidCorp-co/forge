import { describe, expect, it } from 'vitest';
import { buildPlatformInvariantSet, describeInvariantDelta } from './invariant-set.js';

describe('buildPlatformInvariantSet', () => {
  it('is deterministic across calls (C5 — same code, same digest)', () => {
    expect(buildPlatformInvariantSet().digest).toBe(buildPlatformInvariantSet().digest);
  });

  it('covers every mandatory fact and nothing else', async () => {
    const { listFacts } = await import('./registry.js');
    const ids = buildPlatformInvariantSet()
      .entries.map((e) => e.id)
      .sort();
    expect(ids).toEqual(
      listFacts({ tier: 'mandatory' })
        .map((f) => f.id)
        .sort(),
    );
  });

  it('summary carries the id/version/sha the delta parser reads back', () => {
    const { summary, entries } = buildPlatformInvariantSet();
    for (const e of entries) {
      expect(summary).toContain(`${e.id} v${e.version} (${e.sha})`);
    }
  });
});

describe('describeInvariantDelta', () => {
  const base = [{ id: 'pipeline-rules', title: '', version: 4, sha: 'aaaaaaaa' }];

  it('reports the initial snapshot when there is no previous', () => {
    expect(describeInvariantDelta(null, base)).toContain('initial snapshot');
  });

  it('reports no change for an identical set', () => {
    expect(describeInvariantDelta(base, base)).toBe('no change');
  });

  it('names a changed invariant with both versions', () => {
    const next = [{ id: 'pipeline-rules', title: '', version: 5, sha: 'bbbbbbbb' }];
    expect(describeInvariantDelta(base, next)).toBe('changed pipeline-rules v4→v5');
  });

  it('detects a body edit that forgot to bump the version', () => {
    const next = [{ id: 'pipeline-rules', title: '', version: 4, sha: 'cccccccc' }];
    expect(describeInvariantDelta(base, next)).toBe('changed pipeline-rules v4→v4');
  });

  it('names additions and removals', () => {
    const next = [{ id: 'new-rule', title: '', version: 1, sha: 'dddddddd' }];
    expect(describeInvariantDelta(base, next)).toBe('added new-rule v1; removed pipeline-rules');
  });
});
