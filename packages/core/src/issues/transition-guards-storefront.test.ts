import { describe, expect, it } from 'vitest';
import type { CriterionWithVerdict } from './criteria/store.js';
import { evaluateCriteria } from './release-evidence.js';
import { type GuardContext, storefrontDraftFault } from './transition-guards.js';

const ctx = { from: 'in_progress', to: 'awaiting_release' } as unknown as GuardContext;
const draftCriterion = (
  corroboration: 'corroborated' | 'uncorroborated',
): CriterionWithVerdict => ({
  id: 'c1',
  n: 1,
  statement: 's',
  position: 0,
  requirementCriterionId: null,
  latest: {
    id: 'v',
    verdict: 'pass',
    reason: null,
    identityKind: 'storefront_draft',
    commitSha: null,
    runtimeRef: null,
    designWorkflowId: null,
    designFlow: null,
    designRevision: null,
    contractRef: null,
    contractVersion: null,
    storefrontWorkflowId: 'wf-1',
    storefrontDraftVersion: 'a'.repeat(64),
    storefrontEnvironment: 'preview',
    corroboration,
    corroborationNote: corroboration === 'corroborated' ? null : 'http_502',
    evidence: [],
    authorAgency: 'agent',
    backfilled: false,
    createdAt: '2026-10-04T00:00:00.000Z',
  },
});
const fault = (c: CriterionWithVerdict, source: 'git' | 'storefront' | null) => {
  const found = evaluateCriteria([c], null, source);
  if (found.kind !== 'criteria') throw new Error('criteria expected');
  return storefrontDraftFault(ctx, found, source);
};

describe('the awaiting_release guard on a storefront draft (ISS-91)', () => {
  it('planted red: a git project holding only a draft verdict is refused, naming its source', () => {
    const refused = fault(draftCriterion('corroborated'), 'git');
    expect(refused?.code).toBe('VERDICT_IDENTITY_NOT_ADMISSIBLE');
    expect(refused?.detail).toContain('has source `git`');
    expect(refused?.detail).toContain('criteria 1');
  });

  it('lets a storefront project through on a corroborated draft, with no commit', () => {
    expect(fault(draftCriterion('corroborated'), 'storefront')).toBeNull();
  });

  it('refuses an uncorroborated draft, carrying the read that failed', () => {
    const refused = fault(draftCriterion('uncorroborated'), 'storefront');
    expect(refused?.code).toBe('VERDICT_UNCORROBORATED');
    expect(refused?.detail).toContain('1 (http_502)');
  });
});
