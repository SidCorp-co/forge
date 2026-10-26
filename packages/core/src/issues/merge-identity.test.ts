import { describe, expect, it, vi } from 'vitest';

vi.mock('./ports.js', () => ({
  subjectOf: (m: string) => m.split('\n', 1)[0]?.trim() ?? '',
}));

const { changeRequestsNamed } = await import('./merge-identity.js');

describe('changeRequestsNamed: the request a merge commit says it merged', () => {
  it('reads GitLab’s trailer, whatever the project path', () => {
    expect(
      changeRequestsNamed(
        "Merge branch 'fix/login-iss-5' into 'release/stg'\n\nLogin\n\nSee merge request sidcorp-it/canawan-admin-hub-fe!1982",
      ),
    ).toEqual([1982]);
  });

  it('reads GitHub’s merge subject and its squash tail', () => {
    expect(changeRequestsNamed('Merge pull request #12 from acme/fix-x\n\nFix x')).toEqual([12]);
    expect(changeRequestsNamed('fix(core): a thing (#1186)')).toEqual([1186]);
  });

  it('names nothing from a citation in the body or a key', () => {
    expect(changeRequestsNamed('ISS-37 login\n\nsee !1979 and #4 for history')).toEqual([]);
  });
});
