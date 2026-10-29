import { describe, expect, it } from 'vitest';
import { gitlabCaller, gitlabPathKind } from './egress.js';

describe('a GitLab call line', () => {
  it('folds a path into its kind', () => {
    expect(
      gitlabPathKind(
        '/projects/sidcorp-it%2Fcanawan-api/repository/commits/e1d3ef77a30f612ecf9e6d539ef5f2e4089b588a',
      ),
    ).toBe('/projects/:id/repository/commits/:sha');
    expect(
      gitlabPathKind('/projects/sidcorp-it%2Fcanawan-api/repository/branches/release%2Fstg'),
    ).toBe('/projects/:id/repository/branches/:branch');
    expect(gitlabPathKind('/projects/42/merge_requests/7/pipelines?per_page=100&page=1')).toBe(
      '/projects/:id/merge_requests/:n/pipelines',
    );
  });

  it('names the code that asked, outside the integration', () => {
    expect(gitlabCaller()).toMatch(/^integrations\/gitlab\/egress\.test|unknown/);
  });
});
