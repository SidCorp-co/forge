import { describe, expect, it } from 'vitest';
import { describeEmptyProjection } from './projection-health.js';

const report = (hosts: string[], count = 0) => ({
  projectId: 'p1',
  rows: 0,
  bindings: hosts.length,
  hosts,
  inbound: { count, lastAt: count ? new Date('2026-11-06T22:00:00Z') : null },
});

// ISS-980: on epod, a GitLab project, PROJECTION_EMPTY said it had bound no GitHub repository
describe('describeEmptyProjection names the source host the project bound', () => {
  it('names a GitLab binding and its deliveries, and never GitHub', () => {
    const none = describeEmptyProjection(report(['GitLab']));
    expect(none).toContain('its GitLab binding');
    expect(none).toContain('GitLab has never called');
    expect(none).not.toContain('GitHub');
    const some = describeEmptyProjection(report(['GitLab'], 3));
    expect(some).toContain('3 inbound deliveries on its GitLab binding');
    expect(some).not.toContain('GitHub');
  });

  it('names a GitHub binding as before', () => {
    expect(describeEmptyProjection(report(['GitHub']))).toContain('its GitHub binding');
  });

  it('names every host where the project bound more than one', () => {
    expect(describeEmptyProjection(report(['GitHub', 'GitLab']))).toContain(
      'any of its 2 GitHub or GitLab bindings',
    );
  });

  it('says no source host is bound where none is, naming the hosts a repository can live on', () => {
    const why = describeEmptyProjection(report([]));
    expect(why).toContain('this project has bound no source host repository');
  });

  it('answers null where the projection holds a row', () => {
    expect(describeEmptyProjection({ ...report(['GitLab']), rows: 1 })).toBeNull();
  });
});
