import { describe, expect, it } from 'vitest';
import type { MeasuredChange } from './diff.js';
import { namingProblem, proposeVersion, unmeasuredProblem } from './naming.js';

const diff = (
  classification: 'breaking' | 'unknown' | 'non-breaking',
  ...changes: MeasuredChange[]
) => ({
  classification,
  changes,
});
const unloadable: MeasuredChange = {
  element: 'document',
  kind: 'changed',
  level: 'warning',
  text: 'oasdiff could not compare the two versions: failed to load base spec from the previous version',
  check: 'openapi-not-measured',
};
const warned: MeasuredChange = {
  element: 'GET /a',
  kind: 'changed',
  level: 'warning',
  text: 'an enum value was added to a response',
  check: 'response-property-enum-value-added',
};

describe('a version over a change no differ measured', () => {
  it('is not proposed by core: the upload owes the version, refused VERSION_NOT_MEASURED naming why', () => {
    const p = unmeasuredProblem('semver', '2.0.0', diff('unknown', unloadable));
    expect(p?.code).toBe('VERSION_NOT_MEASURED');
    expect(p?.detail).toContain('failed to load base spec');
    expect(p?.detail).toContain('after 2.0.0');
    expect(() =>
      proposeVersion('semver', '2.0.0', diff('unknown', unloadable), '2026-10-06'),
    ).toThrow(/no differ measured/);
  });

  it('is recorded at the version the uploader names, a patch included', () => {
    const d = diff('unknown', unloadable);
    expect(
      namingProblem({ versioning: 'semver', previous: '2.0.0', requested: '2.0.1', diff: d }),
    ).toBeNull();
    expect(
      namingProblem({ versioning: 'semver', previous: '2.0.0', requested: '2.0.0', diff: d })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
  });

  it.each(['opaque', 'contract-type-changed', 'no-previous-artifact', 'graphql-not-measured'])(
    'counts %s as not measured',
    (check) => {
      const d = diff('unknown', { ...unloadable, check });
      expect(unmeasuredProblem('semver', '1.0.0', d)?.code).toBe('VERSION_NOT_MEASURED');
    },
  );

  it('asks nothing of a first version or a dated scheme, whose number claims no compatibility', () => {
    expect(unmeasuredProblem('semver', null, diff('unknown', unloadable))).toBeNull();
    expect(unmeasuredProblem('dated', '2026-10-05', diff('unknown', unloadable))).toBeNull();
    expect(proposeVersion('dated', '2026-10-05', diff('unknown', unloadable), '2026-10-06')).toBe(
      '2026-10-06',
    );
  });
});

describe('a measured change', () => {
  it('that measured unknown still owes a MAJOR, proposed and required', () => {
    const d = diff('unknown', warned);
    expect(unmeasuredProblem('semver', '2.0.0', d)).toBeNull();
    expect(proposeVersion('semver', '2.0.0', d, '2026-10-06')).toBe('3.0.0');
    expect(
      namingProblem({ versioning: 'semver', previous: '2.0.0', requested: '2.1.0', diff: d })?.code,
    ).toBe('VERSION_BUMP_TOO_SMALL');
  });

  it('that a declared semantic change is the uploader word and owes its MAJOR', () => {
    const d = diff('unknown', { ...warned, check: 'semantic-change' });
    expect(unmeasuredProblem('semver', '2.0.0', d)).toBeNull();
    expect(proposeVersion('semver', '2.0.0', d, '2026-10-06')).toBe('3.0.0');
  });

  it('that added an element and broke nothing proposes a MINOR', () => {
    const d = diff('non-breaking', { ...warned, kind: 'added', level: 'info' });
    expect(proposeVersion('semver', '2.0.0', d, '2026-10-06')).toBe('2.1.0');
  });
});
