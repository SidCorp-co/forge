/**
 * ISS-1123 criterion 11 — the sentence that tells an unfed projection from a wrong number.
 *
 * The reading itself is a database query and is proved where the rows are (the merge route's own
 * cases, and `repo-projection-e2e`). What is here is the judgement made over that reading, which is
 * the part an operator actually reads: the condition is the empty projection ALONE, so a project
 * that HAS received deliveries and still holds no row gets this refusal with that cause in it
 * rather than falling back to a sentence about the number the caller sent.
 */

import { describe, expect, it } from 'vitest';
import { describeEmptyProjection, type ProjectionPipeReport } from './projection-health.js';

const report = (over: Partial<ProjectionPipeReport> = {}): ProjectionPipeReport => ({
  projectId: 'project-1',
  rows: 0,
  bindings: 1,
  inbound: { count: 0, lastAt: null },
  ...over,
});

describe('describeEmptyProjection', () => {
  it('says nothing where the projection holds rows, so the number is the caller`s to check', () => {
    expect(describeEmptyProjection(report({ rows: 1 }))).toBeNull();
    expect(
      describeEmptyProjection(report({ rows: 400, inbound: { count: 0, lastAt: null } })),
    ).toBeNull();
  });

  it('names the door nobody has knocked on where no delivery has ever arrived', () => {
    const said = describeEmptyProjection(report()) ?? '';
    expect(said).toContain('holds no pull request at all');
    expect(said).toContain('no webhook delivery has ever reached its GitHub binding');
    expect(said).toContain('forge_github open-pull-request');
    expect(said).toContain('/api/webhooks/in/');
  });

  it('counts the bindings rather than implying there is one', () => {
    expect(describeEmptyProjection(report({ bindings: 3 })) ?? '').toContain(
      'any of its 3 GitHub bindings',
    );
  });

  it('refuses the same way where deliveries HAVE arrived and written no pull request', () => {
    const said =
      describeEmptyProjection(
        report({ inbound: { count: 4, lastAt: new Date('2026-09-19T08:00:00.000Z') } }),
      ) ?? '';
    expect(said).toContain('holds no pull request at all');
    expect(said).toContain('4 inbound deliveries have reached');
    expect(said).toContain('2026-09-19T08:00:00.000Z');
    expect(said).toContain('none of them wrote a pull request');
  });

  it('says a project has bound no repository rather than blaming a door it does not have', () => {
    expect(describeEmptyProjection(report({ bindings: 0 })) ?? '').toContain(
      'bound no GitHub repository',
    );
  });

  it('reads one delivery as singular, because a sentence an operator distrusts gets read twice', () => {
    expect(
      describeEmptyProjection(report({ inbound: { count: 1, lastAt: new Date(0) } })) ?? '',
    ).toContain('1 inbound delivery has reached');
  });
});
