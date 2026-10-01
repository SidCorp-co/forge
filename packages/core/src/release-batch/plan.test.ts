import { describe, expect, it } from 'vitest';
import { production, projectDoc } from '../project-config/release-path.fixture.js';
import { releasePathOf } from '../project-config/release-path.js';
import type { ProjectDocument } from '../project-config/schema.js';
import { releaseBranches } from './plan.js';

function branchesOf(document: ProjectDocument) {
  const read = releasePathOf(1, document);
  if (!read.ok) throw new Error(read.reason);
  return releaseBranches(read.path);
}

describe('releaseBranches', () => {
  it('promotes staging → master where production deploys from a branch a promotion reaches', () => {
    expect(
      branchesOf(
        projectDoc({
          defaultBranch: 'staging',
          promotions: [{ from: 'staging', to: 'master', via: 'merge' }],
          environments: { live: production({ deploysFrom: 'master' }) },
        }),
      ),
    ).toEqual({ defaultBranch: 'staging', deploysFrom: 'master', promotePlanned: true });
  });

  it('plans no promotion where there is no production environment', () => {
    expect(branchesOf(projectDoc({ defaultBranch: 'release/stg' }))).toEqual({
      defaultBranch: 'release/stg',
      deploysFrom: 'release/stg',
      promotePlanned: false,
    });
  });

  it('plans no promotion where production deploys from the branch work lands on', () => {
    expect(
      branchesOf(projectDoc({ environments: { live: production({ deploysFrom: 'main' }) } })),
    ).toEqual({ defaultBranch: 'main', deploysFrom: 'main', promotePlanned: false });
  });

  it('crosses into the LAST branch of a path longer than one promotion', () => {
    expect(
      branchesOf(
        projectDoc({
          defaultBranch: 'dev',
          promotions: [
            { from: 'dev', to: 'stg', via: 'merge' },
            { from: 'stg', to: 'main', via: 'cherry-pick' },
          ],
          environments: { live: production({ deploysFrom: 'main' }) },
        }),
      ),
    ).toEqual({ defaultBranch: 'dev', deploysFrom: 'main', promotePlanned: true });
  });

  it('answers null on both branches for a project with no git source, never guessing main', () => {
    expect(branchesOf(projectDoc({ source: 'none' }))).toEqual({
      defaultBranch: null,
      deploysFrom: null,
      promotePlanned: false,
    });
  });
});
