import { describe, expect, it } from 'vitest';
import type { MeasuredChange } from './diff.js';
import { compareVersions, namingProblem, proposeVersion } from './naming.js';

const added: MeasuredChange = { element: 'GET /a', kind: 'added', level: 'info', text: 'added' };
const diff = (
  classification: 'breaking' | 'non-breaking' | 'unknown' | 'initial',
  changes: MeasuredChange[] = [],
) => ({
  classification,
  changes,
});

describe('core proposes the next version from the measured diff', () => {
  it.each([
    [null, 'initial', [], '1.0.0'],
    ['1.4.2', 'breaking', [], '2.0.0'],
    ['1.4.2', 'unknown', [], '2.0.0'],
    ['1.4.2', 'non-breaking', [added], '1.5.0'],
    ['1.4.2', 'non-breaking', [], '1.4.3'],
  ] as const)('semver after %s, %s → %s', (prev, cls, changes, want) => {
    expect(proposeVersion('semver', prev, diff(cls, [...changes]), '2026-10-01')).toBe(want);
  });

  it.each([
    [null, '2026-10-01'],
    ['2026-09-20', '2026-10-01'],
    ['2026-10-01', '2026-10-01.1'],
    ['2026-10-01.9', '2026-10-01.10'],
    ['2026-10-03', '2026-10-03.1'],
  ])('dated after %s → %s', (prev, want) => {
    expect(proposeVersion('dated', prev, diff('breaking'), '2026-10-01')).toBe(want);
  });

  it('orders a dated suffix by number, not by text', () => {
    expect(compareVersions('dated', '2026-10-01.10', '2026-10-01.9')).toBeGreaterThan(0);
    expect(compareVersions('semver', '1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('dated', '2026-10-01.9', '2026-10-01.10')).toBeLessThan(0);
  });
});

describe('a version the provider names is held to the measured change', () => {
  it('refuses a semver MINOR for a breaking change, naming the next MAJOR (VERSION_BUMP_TOO_SMALL)', () => {
    const p = namingProblem({
      versioning: 'semver',
      previous: '1.4.2',
      requested: '1.5.0',
      diff: diff('breaking'),
    });
    expect(p?.code).toBe('VERSION_BUMP_TOO_SMALL');
    expect(p?.detail).toMatch(
      /owes a MAJOR bump after 1\.4\.2; "1\.5\.0" is smaller, and the next version is 2\.0\.0/,
    );
  });

  it('refuses a MINOR for an unknown change too, since unknown is never read as compatible', () => {
    expect(
      namingProblem({
        versioning: 'semver',
        previous: '1.4.2',
        requested: '1.5.0',
        diff: diff('unknown'),
      })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
  });

  it('refuses a PATCH where a field was added', () => {
    expect(
      namingProblem({
        versioning: 'semver',
        previous: '1.4.2',
        requested: '1.4.3',
        diff: diff('non-breaking', [added]),
      })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
  });

  it('takes a MAJOR for a breaking change, and a larger one than owed', () => {
    expect(
      namingProblem({
        versioning: 'semver',
        previous: '1.4.2',
        requested: '2.0.0',
        diff: diff('breaking'),
      }),
    ).toBeNull();
    expect(
      namingProblem({
        versioning: 'semver',
        previous: '1.4.2',
        requested: '3.0.0',
        diff: diff('non-breaking'),
      }),
    ).toBeNull();
  });

  it('refuses a version at or before the latest, in either scheme', () => {
    expect(
      namingProblem({
        versioning: 'semver',
        previous: '2.0.0',
        requested: '2.0.0',
        diff: diff('non-breaking'),
      })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
    expect(
      namingProblem({
        versioning: 'dated',
        previous: '2026-10-01',
        requested: '2026-09-30',
        diff: diff('breaking'),
      })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
  });

  it('refuses a name outside the scheme, saying the shape', () => {
    const p = namingProblem({
      versioning: 'semver',
      previous: null,
      requested: 'v2',
      diff: diff('initial'),
    });
    expect(p).toEqual({
      code: 'VERSION_NOT_IN_SCHEME',
      detail: expect.stringContaining('MAJOR.MINOR.PATCH'),
    });
    expect(
      namingProblem({
        versioning: 'dated',
        previous: null,
        requested: '2026-13-45',
        diff: diff('initial'),
      })?.code,
    ).toBe('VERSION_NOT_IN_SCHEME');
  });
});
