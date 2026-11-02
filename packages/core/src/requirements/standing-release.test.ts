// ISS-900: a verdict judged on a release, on a project whose production names no commit it serves,
// is weighed on the agent's release record alone (`standing-identity.ts:atRelease`), and the standing
// asks for that judgement, or for the record, never for one that cannot count (`releaseAskOf`).
// @direct-test-of packages/core/src/requirements/standing-identity.ts
// @direct-test-of packages/core/src/requirements/standing-proof.ts
import { describe, expect, it } from 'vitest';
import { atRelease, type ReleasedLine, releaseHint } from './standing-identity.js';
import { releaseAskOf } from './standing-proof.js';

const WHY = 'its production `production` declares no source probe';
const at = (day: number) => new Date(Date.UTC(2026, 10, day));

const line = (
  live: string | null,
  shipped: Record<string, boolean> = live ? { [live]: true } : {},
): ReleasedLine => ({
  why: WHY,
  live: live ? { version: live, at: at(2) } : null,
  shipped: new Map(Object.entries(shipped).map(([v, carried]) => [v, { at: at(1), carried }])),
});

describe('a verdict judged on a release', () => {
  it('counts on the release the record says is live', () => {
    expect(atRelease('0.76.0', line('0.76.0'))).toEqual({
      commit: null,
      inLiveBuild: true,
      notCounted: null,
    });
  });

  it('counts on an earlier release the live one carries, saying so', () => {
    const r = atRelease('0.76.0', line('0.77.0', { '0.76.0': true, '0.77.0': true }));
    expect(r.notCounted).toBeNull();
    expect(r.countedAs).toBe('release 0.76.0, carried by live release 0.77.0');
  });

  it('does not count under a release recorded later at a lower version', () => {
    const r = atRelease('0.76.0', line('0.75.1', { '0.76.0': false, '0.75.1': true }));
    expect(r.inLiveBuild).toBe(false);
    expect(r.notCounted).toContain('judge it again on release 0.75.1');
  });

  it('does not count on a version no record shipped, or with none shipped', () => {
    expect(atRelease('0.80.0', line('0.76.0')).notCounted).toContain(
      'which no release this project recorded as shipped names',
    );
    expect(atRelease('0.76.0', line(null)).notCounted).toBe(
      `judged on release 0.76.0, and no release is recorded as shipped: ${WHY}`,
    );
  });

  it('does not count where production reads its commit, which a verdict there names', () => {
    expect(atRelease('0.76.0', undefined)).toMatchObject({ inLiveBuild: null });
    expect(atRelease('0.76.0', undefined).notCounted).toContain('names the commit judged');
  });
});

describe('what the standing asks where a verdict counts only on a release', () => {
  const live = { sha: null, holds: new Map(), runtimes: new Map(), unanswered: new Map() };

  it('names the live release, or none recorded', () => {
    expect(releaseAskOf({ ...live, released: line('0.76.0') })).toEqual({ version: '0.76.0' });
    expect(releaseAskOf({ ...live, released: line(null) })).toBe('none');
    expect(releaseHint(line('0.76.0'))).toContain("{ kind: 'release', version: '0.76.0' }");
  });

  it('asks as before where production reads its commit, or issues weigh at their landings', () => {
    expect(releaseAskOf(live)).toBeNull();
    expect(releaseAskOf(null)).toBeNull();
    expect(releaseAskOf({ ...live, released: line('0.76.0'), landed: new Map() })).toBeNull();
    expect(releaseHint(undefined)).toBeNull();
  });
});
