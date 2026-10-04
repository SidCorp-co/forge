import { describe, expect, it } from 'vitest';
import type { CriterionWithVerdict, LatestVerdict } from './criteria/store.js';
import { evaluateCriteria } from './release-evidence.js';

const verdict = (over: Partial<LatestVerdict>): LatestVerdict => ({
  id: 'v',
  verdict: 'pass',
  reason: null,
  identityKind: 'commit',
  commitSha: '3641ba21fec5096e2d1a91a40f2d9e50e9239068',
  runtimeRef: null,
  designWorkflowId: null,
  designFlow: null,
  designRevision: null,
  contractRef: null,
  contractVersion: null,
  storefrontWorkflowId: null,
  storefrontDraftVersion: null,
  storefrontEnvironment: null,
  corroboration: null,
  corroborationNote: null,
  evidence: [],
  authorAgency: 'agent',
  backfilled: false,
  createdAt: '2026-10-03T00:00:00.000Z',
  ...over,
});
const criterion = (n: number, latest: LatestVerdict | null): CriterionWithVerdict => ({
  id: `c${n}`,
  n,
  statement: 's',
  position: n,
  requirementCriterionId: null,
  latest,
});

describe('evaluateCriteria (ISS-55: the awaiting_release gate off criterion_verdicts)', () => {
  it('owes criteria where the issue has none', () => {
    expect(evaluateCriteria([])).toEqual({ kind: 'no-criteria' });
  });

  it('passes every criterion whose latest verdict passes with an identity', () => {
    expect(
      evaluateCriteria([criterion(1, verdict({})), criterion(2, verdict({ verdict: 'short' }))]),
    ).toEqual({
      kind: 'criteria',
      unpassed: [],
      unidentified: [],
      predateReopen: [],
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('never counts skipped or fail as a pass, and names a criterion never judged', () => {
    const found = evaluateCriteria([
      criterion(
        1,
        verdict({ verdict: 'skipped', reason: 'no host', identityKind: null, commitSha: null }),
      ),
      criterion(2, verdict({ verdict: 'fail' })),
      criterion(3, null),
    ]);
    expect(found).toEqual({
      kind: 'criteria',
      unpassed: [
        { criterion: 1, verdict: 'skipped' },
        { criterion: 2, verdict: 'fail' },
        { criterion: 3, verdict: null },
      ],
      unidentified: [],
      predateReopen: [],
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('does not accept a backfilled commit_unresolved as an identity: the amnesty ends on reopen', () => {
    const found = evaluateCriteria([
      criterion(
        1,
        verdict({ identityKind: 'commit_unresolved', commitSha: '1810f84', backfilled: true }),
      ),
    ]);
    expect(found).toEqual({
      kind: 'criteria',
      unpassed: [],
      unidentified: [1],
      predateReopen: [],
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('a passing verdict at or before the latest reopen is not current; one after it is', () => {
    const reopenedAt = new Date('2026-10-03T12:00:00.000Z');
    const found = evaluateCriteria(
      [
        criterion(1, verdict({ createdAt: '2026-10-03T11:59:59.999Z' })),
        criterion(2, verdict({ createdAt: '2026-10-03T12:00:00.000Z' })),
        criterion(3, verdict({ createdAt: '2026-10-03T12:00:00.001Z' })),
        criterion(4, verdict({ verdict: 'fail', createdAt: '2026-10-03T11:00:00.000Z' })),
      ],
      reopenedAt,
    );
    expect(found).toEqual({
      kind: 'criteria',
      unpassed: [{ criterion: 4, verdict: 'fail' }],
      unidentified: [],
      predateReopen: [1, 2],
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('an issue never reopened reads every verdict as current', () => {
    const found = evaluateCriteria([criterion(1, verdict({ createdAt: '2020-01-01T00:00:00Z' }))]);
    expect(found).toEqual({
      kind: 'criteria',
      unpassed: [],
      unidentified: [],
      predateReopen: [],
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });
});

describe('evaluateCriteria: a storefront draft (ISS-91)', () => {
  const draft = (over: Partial<LatestVerdict>) =>
    verdict({
      identityKind: 'storefront_draft',
      commitSha: null,
      storefrontWorkflowId: 'b2eb2792-a043-4d5f-80a3-50a32c29e6e9',
      storefrontDraftVersion: 'a'.repeat(64),
      storefrontEnvironment: 'preview',
      corroboration: 'corroborated',
      ...over,
    });
  const clean = { kind: 'criteria', unpassed: [], unidentified: [], predateReopen: [] };

  it('counts a corroborated draft as a landed commit in a storefront project, with no commit at all', () => {
    expect(evaluateCriteria([criterion(1, draft({}))], null, 'storefront')).toEqual({
      ...clean,
      inadmissible: [],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('planted red: a git project with only a draft verdict stays refused, naming the criterion', () => {
    expect(
      evaluateCriteria([criterion(1, draft({})), criterion(2, verdict({}))], null, 'git'),
    ).toEqual({
      ...clean,
      inadmissible: [1],
      superseded: [],
      uncorroborated: [],
    });
  });

  it('refuses a draft where no project document says the source is a storefront', () => {
    expect(evaluateCriteria([criterion(1, draft({}))])).toMatchObject({ inadmissible: [1] });
  });

  it('refuses an uncorroborated draft in a storefront project, carrying why the read failed', () => {
    const found = evaluateCriteria(
      [criterion(3, draft({ corroboration: 'uncorroborated', corroborationNote: 'http_502' }))],
      null,
      'storefront',
    );
    expect(found).toMatchObject({
      inadmissible: [],
      superseded: [],
      uncorroborated: [{ criterion: 3, note: 'http_502' }],
    });
  });

  it('still counts design and commit identities on a git project exactly as before', () => {
    const found = evaluateCriteria(
      [
        criterion(1, verdict({})),
        criterion(2, verdict({ identityKind: 'design', commitSha: null, designRevision: 6 })),
      ],
      null,
      'git',
    );
    expect(found).toEqual({ ...clean, inadmissible: [], superseded: [], uncorroborated: [] });
  });

  it('refuses a draft the storefront has moved past as superseded, never as corroborated (FB-56)', () => {
    const found = evaluateCriteria(
      [
        criterion(1, draft({ corroboration: 'superseded', corroborationNote: 'moved to bbb' })),
        criterion(2, draft({})),
      ],
      null,
      'storefront',
    );
    expect(found).toEqual({
      ...clean,
      inadmissible: [],
      superseded: [{ criterion: 1, note: 'moved to bbb' }],
      uncorroborated: [],
    });
  });
});
